// Pull schema.org Event data out of HTML (JSON-LD) — the format event sites publish specifically for search engines.
const { CITIES } = require('../catalog');
const { resolveCity, matchCategory } = require('../aggregator');
const { istISO, haversineKm } = require('../util');

const decode = s => String(s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const first = v => (Array.isArray(v) ? v[0] : v);
const typeOf = n => [].concat(n?.['@type'] || []).join(' ');

function jsonBlocks(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let txt = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try { out.push(JSON.parse(txt)); continue; } catch {}
    try { out.push(JSON.parse(txt.replace(/[\u0000-\u001f]+/g, ' '))); } catch {}
  }
  return out;
}

// walk any JSON-LD shape: arrays, @graph, ItemList, nested "event"/"subEvent"
function collect(data, events, urls) {
  const stack = [data];
  let guard = 0;
  while (stack.length && guard++ < 5000) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) { stack.push(...n); continue; }
    const t = typeOf(n);
    if (/Event\b/.test(t) && n.name && n.startDate) events.push(n);
    else if (/ListItem/.test(t) && typeof n.url === 'string' && !n.item) urls.push(n.url);
    for (const k of ['@graph', 'itemListElement', 'item', 'event', 'events', 'subEvent', 'mainEntity', 'about']) if (n[k]) stack.push(n[k]);
  }
}

function extractEvents(html) {
  const events = [], urls = [];
  for (const b of jsonBlocks(html)) collect(b, events, urls);
  return { events, urls };
}

const MAP_TYPES = { MusicEvent: 'music', ComedyEvent: 'comedy', TheaterEvent: 'theatre', Festival: 'festivals', SportsEvent: 'sports', EducationEvent: 'workshops', BusinessEvent: 'networking', SocialEvent: 'meetups', ScreeningEvent: 'screenings', ExhibitionEvent: 'arts', VisualArtsEvent: 'arts', DanceEvent: 'parties', FoodEvent: 'food', LiteraryEvent: 'openmic', ChildrensEvent: 'festivals' };

// "2026-10-03T19:00:00+05:30" | "2026-10-03T19:00" (assume IST) | "2026-10-03" (all day)
function parseDate(v) {
  const s = String(first(v) || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!m) { const d = new Date(s); return isNaN(d) ? null : { iso: d.toISOString(), allDay: false }; }
  const [, y, mo, d, h, mi, , tz] = m;
  if (h == null) return { iso: istISO(+y, +mo, +d, 10, 0), allDay: true, y: +y, m: +mo, d: +d };
  if (tz) return { iso: new Date(s.replace(' ', 'T')).toISOString(), allDay: false };
  return { iso: istISO(+y, +mo, +d, +h, +mi), allDay: false };
}

function nearestArea(city, lat, lng) {
  let best = null, bd = Infinity;
  for (const a of city.areas) { const d = haversineKm({ lat, lng }, a); if (d < bd) { bd = d; best = a; } }
  return bd < 25 ? best : null;
}

// JSON-LD Event → aggregator record (listed event, link back to the source page)
function toRecord(ev, pageUrl, site) {
  const status = String(ev.eventStatus || '');
  if (/Cancelled|Postponed/i.test(status)) return { skip: 'cancelled' };
  const loc = first(ev.location) || {};
  const online = /Online/i.test(String(ev.eventAttendanceMode || '')) || /VirtualLocation/.test(typeOf(loc));
  if (online && !/Mixed/i.test(String(ev.eventAttendanceMode || ''))) return { skip: 'online' };
  const start = parseDate(ev.startDate); if (!start) return { skip: 'no date' };
  const endP = ev.endDate ? parseDate(ev.endDate) : null;
  const addr = typeof loc.address === 'string' ? { streetAddress: loc.address } : (first(loc.address) || {});
  const addrText = decode([addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(', '));
  const venue = decode(loc.name || addr.streetAddress || '').slice(0, 90) || 'Venue on listing';
  const cityId = resolveCity(decode(addr.addressLocality), decode(addr.addressRegion), addrText, venue, decode(ev.name));
  const city = CITIES.find(c => c.id === cityId);
  if (!city) return { skip: 'outside our cities' };
  const geo = first(loc.geo) || {};
  let lat = parseFloat(geo.latitude), lng = parseFloat(geo.longitude);
  const hasGeo = Number.isFinite(lat) && Number.isFinite(lng) && haversineKm({ lat, lng }, city) < 60;
  const areaByName = city.areas.find(a => addrText.toLowerCase().includes(a.name.split(',')[0].toLowerCase()));
  const area = hasGeo ? nearestArea(city, lat, lng) || areaByName : areaByName;
  if (!hasGeo) { lat = area ? area.lat : city.lat; lng = area ? area.lng : city.lng; }
  const offers = [].concat(ev.offers || []).flatMap(o => [].concat(o?.offers || o));
  const prices = offers.map(o => parseFloat(o?.lowPrice ?? o?.price)).filter(p => Number.isFinite(p) && p >= 0);
  const free = ev.isAccessibleForFree === true || /^true$/i.test(String(ev.isAccessibleForFree)) || (prices.length && Math.min(...prices) === 0);
  const offerUrl = offers.map(o => o?.url).find(u => typeof u === 'string' && /^https?:/.test(u));
  const url = (typeof ev.url === 'string' && /^https?:/.test(ev.url) ? ev.url : null) || pageUrl;
  const title = decode(ev.name).slice(0, 140);
  const desc = decode(ev.description).slice(0, 300);
  const type = typeOf(ev).split(' ').map(t => MAP_TYPES[t]).find(Boolean);
  let durH = endP ? (new Date(endP.iso) - new Date(start.iso)) / 3600000 : start.allDay ? 13.5 : 3;
  if (!(durH > 0) || durH > 24 * 45) durH = start.allDay ? 13.5 : 3;
  if (start.allDay && !endP) durH = 13.5; // whole day until 23:30
  return {
    record: {
      source: 'crawl', site: site.name,
      // events listed on one page without their own URL must not share an id
      sourceId: require('crypto').createHash('sha1').update(url.split('#')[0].replace(/\?.*$/, '') + (ev.url ? '' : `|${title}|${start.iso}`)).digest('hex').slice(0, 16),
      url, title, category: matchCategory(title, desc) || type || matchCategory(venue) || 'arts',
      city: city.id, area: area ? { name: area.name, zone: area.zone } : { name: decode(addr.addressLocality) || city.short, zone: null },
      venue, address: addrText.slice(0, 200), lat, lng, approxLocation: !hasGeo && !area,
      start: start.iso, durH: Math.round(durH * 10) / 10, allDay: start.allDay,
      tiers: [], priceMin: free ? 0 : prices.length ? Math.min(...prices) : null,
      description: desc, organizer: decode(first(ev.organizer)?.name) || null, image: null, external: true,
      links: [{ source: site.name, url: offerUrl && new URL(offerUrl).hostname === new URL(url).hostname ? offerUrl : url, type: 'tickets' }],
    },
  };
}

// links to event detail pages on a listing page (same host, matching the site's pattern)
function eventLinks(html, baseUrl, pattern) {
  const out = new Set(); const base = new URL(baseUrl);
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try { const u = new URL(decode(m[1]), base); if (u.hostname === base.hostname && pattern.test(u.pathname)) { u.hash = ''; out.add(u.toString()); } } catch {}
  }
  return [...out];
}

module.exports = { extractEvents, toRecord, eventLinks, parseDate, decode };
