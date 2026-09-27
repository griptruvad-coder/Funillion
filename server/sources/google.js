// Real events source: Google Events via SerpApi (https://serpapi.com/google-events-api)
// Google already aggregates BookMyShow, District, AllEvents, Insider, Luma, Townscript… into its Events cards,
// so one query per city/category brings in listings from every platform. We store facts + links only.
const { CITIES } = require('../catalog');
const { resolveCity, inferCategory } = require('../aggregator');
const { istISO, istDateParts, haversineKm } = require('../util');

const KEY = process.env.SERPAPI_KEY || '';
const API = process.env.SERPAPI_BASE || 'https://serpapi.com/search.json';
const MONTHLY_LIMIT = Number(process.env.SERPAPI_MONTHLY_LIMIT) || 240; // free plan = 250
const REFRESH_DAYS = Number(process.env.SERPAPI_REFRESH_DAYS) || 7;
const QUERIES = (process.env.SERPAPI_QUERIES || 'Events in {city}|Concerts in {city}|Comedy shows in {city}|Workshops in {city}').split('|').map(s => s.trim()).filter(Boolean);
const CITY_FILTER = (process.env.SERPAPI_CITIES || '').split(',').map(s => s.trim()).filter(Boolean);

const enabled = () => Boolean(KEY);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

// ---------- date parsing ("Sun, Dec 7, 8:00 – 9:30 PM IST", "Dec 2, 9:00 PM – Dec 30, 10:30 PM", "Today, 7 – 10 PM", "Oct 3 – 5")
function pickYear(month, day, now = new Date()) {
  const t = istDateParts(now);
  let y = t.y;
  const diffDays = (Date.UTC(y, month - 1, day) - Date.UTC(t.y, t.m - 1, t.d)) / 86400000;
  if (diffDays < -60) y += 1; // "Jan 5" seen in November = next year
  return y;
}
function parseDatePart(part, fallback, now) {
  const t = istDateParts(now);
  if (/\btoday\b|\btonight\b/i.test(part)) return { y: t.y, m: t.m, d: t.d, rest: part.replace(/today|tonight/i, '') };
  if (/\btomorrow\b/i.test(part)) { const x = new Date(Date.UTC(t.y, t.m - 1, t.d + 1)); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), rest: part.replace(/tomorrow/i, '') }; }
  const m = part.match(MONTH_RE);
  if (m) { const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; const d = +m[2]; return { y: pickYear(mo, d, now), m: mo, d, rest: part.replace(m[0], '') }; }
  if (fallback) return { ...fallback, rest: part };
  return null;
}
function parseTime(str) {
  const clean = str.replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b,?/ig, '');
  const m = clean.match(TIME_RE);
  if (!m) return null;
  let h = +m[1]; const min = +(m[2] || 0); const mer = m[3]?.toLowerCase() || null;
  if (h > 23 || min > 59) return null;
  return { h, min, mer };
}
const to24 = ({ h, min, mer }) => ({ h: mer === 'pm' && h < 12 ? h + 12 : mer === 'am' && h === 12 ? 0 : h, min });

function parseWhen(date = {}, now = new Date()) {
  const when = String(date.when || date.start_date || '').replace(/\s+(IST|GMT[+\-]?[\d:]*|UTC[+\-]?[\d:]*|CST|CDT|EST|EDT|PST|PDT|MST|MDT|BST|CET|CEST|SGT|GST|AEST|JST)$/, '').trim();
  const [startRaw, endRaw = ''] = when.split(/\s+[–—-]\s+/);
  const startDate = parseDatePart(startRaw, null, now) || (date.start_date ? parseDatePart(date.start_date, null, now) : null);
  if (!startDate) return null;
  let st = parseTime(startDate.rest);
  // "Oct 10 – 12" = a date range, not a time
  const bareDay = !st && /^\d{1,2}$/.test(endRaw.trim());
  const endDate = bareDay ? { y: startDate.y, m: startDate.m, d: +endRaw.trim(), rest: '' } : parseDatePart(endRaw, { y: startDate.y, m: startDate.m, d: startDate.d }, now);
  let et = endDate && !bareDay ? parseTime(endDate.rest) : null;
  // "7 – 10 PM": start inherits the end's AM/PM
  if (st && !st.mer && et?.mer) { st.mer = et.mer; if (et.mer === 'pm' && st.h > et.h && st.h < 12) st.mer = 'am'; }
  if (st && !st.mer) st.mer = st.h < 8 ? 'pm' : st.h < 12 ? 'am' : null;
  const allDay = !st;
  const s = st ? to24(st) : { h: 10, min: 0 };
  const start = istISO(startDate.y, startDate.m, startDate.d, s.h, s.min);
  let end;
  if (et) { const e = to24(et); end = istISO(endDate.y, endDate.m, endDate.d, e.h, e.min); if (new Date(end) <= new Date(start)) end = new Date(new Date(end).getTime() + 86400000).toISOString(); }
  else if (endDate && (endDate.d !== startDate.d || endDate.m !== startDate.m)) end = istISO(endDate.y, endDate.m, endDate.d, 20, 0);
  else end = new Date(new Date(start).getTime() + (allDay ? 8 : 3) * 3600000).toISOString();
  return { start, end, durH: Math.max(0.5, Math.round((new Date(end) - new Date(start)) / 360000) / 10), allDay };
}

// ---------- location
const GENERIC = new Set(['sector', 'north', 'south', 'east', 'west', 'new', 'old', 'lower', 'city', 'road', 'central', 'fort', 'law', 'park', 'college', 'industrial', 'vijay', 'mg']);
function areaFromText(city, text) {
  const t = text.toLowerCase();
  return city.areas.find(a => t.includes(a.name.split(',')[0].toLowerCase())) ||
    city.areas.find(a => { const w = a.name.split(/[ ,]/)[0].toLowerCase(); return w.length >= 4 && !GENERIC.has(w) && t.includes(w); }) || null;
}
function nearestArea(city, lat, lng) {
  let best = null, bd = Infinity;
  for (const a of city.areas) { const d = haversineKm({ lat, lng }, a); if (d < bd) { bd = d; best = a; } }
  return bd < 30 ? best : null;
}

// ---------- normalise one Google result → aggregator record
function toRecord(item, queryCity, queryCat, now) {
  if (!item?.title) return null;
  const when = parseWhen(item.date, now);
  if (!when) return null;
  const address = Array.isArray(item.address) ? item.address : [];
  const addrText = address.join(', ');
  // trust the address; an address outside our 14 cities is skipped rather than mislabelled
  const cityId = address.length ? resolveCity(address[address.length - 1], addrText) : queryCity.id;
  const city = CITIES.find(c => c.id === cityId);
  if (!city) return null;
  const venue = String(item.venue?.name || address[0]?.split(',')[0] || 'Venue on listing').slice(0, 90);
  const area = areaFromText(city, addrText);
  const links = (item.ticket_info || []).filter(t => /^https?:\/\//.test(t.link || '')).map(t => ({ source: String(t.source || '').slice(0, 40), url: t.link, type: t.link_type === 'tickets' ? 'tickets' : 'info' }));
  if (item.link && !links.some(l => l.url === item.link)) links.push({ source: 'Google', url: item.link, type: 'info' });
  const desc = String(item.description || '').replace(/\s+/g, ' ').trim();
  const price = desc.match(/(?:₹|rs\.?|inr)\s?([\d,]{2,7})/i);
  const free = /\bfree (entry|event|admission)\b|\bentry free\b/i.test(desc + ' ' + item.title);
  const id = require('crypto').createHash('sha1').update(`${item.title}|${when.start}|${venue}`).digest('hex').slice(0, 14);
  return {
    source: 'google', sourceId: id, url: links.find(l => l.type === 'tickets')?.url || item.link || null,
    title: String(item.title).slice(0, 140), category: inferCategory(item.title, desc, queryCat),
    city: city.id, area: area || { name: address[1]?.split(',')[0] || city.short, zone: null, lat: city.lat, lng: city.lng, approx: true },
    venue, address: addrText.slice(0, 200), lat: area ? area.lat + (Math.random() - 0.5) * 0.006 : city.lat, lng: area ? area.lng + (Math.random() - 0.5) * 0.006 : city.lng,
    approxLocation: true, start: when.start, durH: when.durH, allDay: when.allDay,
    tiers: [], priceMin: free ? 0 : price ? Number(price[1].replace(/,/g, '')) : null,
    description: desc.slice(0, 320), organizer: null, image: null,
    external: true, links: links.slice(0, 6), mapsUrl: item.event_location_map?.link || null,
  };
}

// ---------- fetching with a monthly budget
function usage(db) {
  const t = istDateParts(); const month = `${t.y}-${String(t.m).padStart(2, '0')}`;
  db.meta.google ||= {};
  if (db.meta.google.month !== month) Object.assign(db.meta.google, { month, used: 0 });
  return db.meta.google;
}

async function search(q, extra = {}) {
  const url = new URL(API);
  url.search = new URLSearchParams({ engine: 'google_events', q, hl: 'en', gl: 'in', api_key: KEY, ...extra }).toString();
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `SerpApi ${res.status}`);
    return data.events_results || [];
  } finally { clearTimeout(timer); }
}

const catHint = q => (/concert|music|gig/i.test(q) ? 'concert live music' : /comedy|stand/i.test(q) ? 'comedy stand-up' : /workshop/i.test(q) ? 'workshop' : /hackathon/i.test(q) ? 'hackathon' : /party|night/i.test(q) ? 'party nightlife' : '');

// Runs one refresh: every city × every query, stopping at the monthly budget
async function run(db, ingest, { force = false, log = console.log } = {}) {
  if (!enabled()) return { skipped: 'SERPAPI_KEY not set' };
  const u = usage(db);
  if (u.running) return { skipped: 'already running' };
  if (!force && u.lastRun && Date.now() - new Date(u.lastRun).getTime() < REFRESH_DAYS * 86400000) return { skipped: 'fresh', lastRun: u.lastRun };
  u.running = true;
  const stats = { startedAt: new Date().toISOString(), queries: 0, results: 0, created: 0, merged: 0, updated: 0, skipped: 0, errors: [] };
  const cities = CITIES.filter(c => !CITY_FILTER.length || CITY_FILTER.includes(c.id));
  const now = new Date();
  try {
    outer: for (const city of cities) {
      for (const tpl of QUERIES) {
        if (u.used >= MONTHLY_LIMIT) { stats.errors.push(`Monthly limit ${MONTHLY_LIMIT} reached — raise SERPAPI_MONTHLY_LIMIT on a paid plan`); break outer; }
        const q = tpl.replace('{city}', city.id === 'delhi' ? 'Delhi' : city.short);
        let items = [];
        try { items = await search(q); u.used++; stats.queries++; }
        catch (e) { stats.errors.push(`${q}: ${e.message}`); if (/invalid api key|run out of searches|account/i.test(e.message)) break outer; continue; }
        for (const it of items) {
          stats.results++;
          const rec = toRecord(it, city, catHint(q), now);
          if (!rec || new Date(rec.start) < Date.now() - 6 * 3600000) { stats.skipped++; continue; }
          const r = ingest(db, rec);
          stats[r.action] = (stats[r.action] || 0) + 1;
        }
        await new Promise(r => setTimeout(r, 250));
      }
    }
  } finally {
    u.running = false;
    u.lastAttempt = new Date().toISOString();
    if (stats.queries > 0) u.lastRun = u.lastAttempt; // a run where every search failed is retried in 6 h, not 7 days
    u.last = { ...stats, finishedAt: new Date().toISOString() };
  }
  log(`› Google Events: ${stats.queries} searches → ${stats.results} results → ${stats.created} new, ${stats.merged} merged, ${stats.updated} updated`);
  return stats;
}

// ---------- optional geocoding via OpenStreetMap Nominatim (1 req/sec, cached) so map pins land on the real venue
async function geocodePending(db, { limit = 120, log = console.log } = {}) {
  if (process.env.GEOCODE === 'off') return 0;
  db.geocache ||= {};
  const pending = Object.values(db.events).filter(e => e.approxLocation === true && e.address && new Date(e.start) > Date.now()).slice(0, limit);
  let done = 0;
  for (const e of pending) {
    const key = `${e.venue}|${e.address}`.toLowerCase();
    let hit = db.geocache[key];
    if (hit === undefined) {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(e.address)}`;
        const res = await fetch(url, { headers: { 'user-agent': `Funillion/1.0 (${process.env.CONTACT_EMAIL || 'events app'})` } });
        const j = await res.json();
        hit = j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
      } catch { hit = null; }
      db.geocache[key] = hit;
      await new Promise(r => setTimeout(r, 1100));
    }
    const city = CITIES.find(c => c.id === e.city);
    if (hit && city && haversineKm(hit, city) < 60) {
      e.lat = hit.lat; e.lng = hit.lng; e.approxLocation = false;
      const a = nearestArea(city, hit.lat, hit.lng); if (a) { e.area = a.name; e.zone = a.zone; }
      done++;
    } else e.approxLocation = 'failed';
  }
  if (done) log(`› Geocoded ${done} venues`);
  return done;
}

module.exports = { enabled, run, parseWhen, toRecord, geocodePending, usage, MONTHLY_LIMIT, REFRESH_DAYS, QUERIES };
