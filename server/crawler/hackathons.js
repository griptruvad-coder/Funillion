// Hackathon platforms — read from the public JSON these sites use for their own listing pages.
// Every request still goes through the crawler's politeGet (robots.txt + spacing), so a site that disallows it is skipped.
//
// Each source returns plain "hack" objects; hackToRecord() turns them into aggregator records.
// Online hackathons are kept too: they get city "online" and show up for everyone (Discover → Hackathons, /in/online/hackathons).
const { CITIES } = require('../catalog');
const { resolveCity } = require('../aggregator');
const { istISO } = require('../util');
const { parseDate, decode } = require('./extract');

const DAY = 86400000;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pick = (o, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return null; };
const str = v => (v == null ? '' : typeof v === 'object' ? String(v.name || v.title || v.label || '') : String(v));

// Devpost style ranges: "Dec 11 - 15, 2026" · "Sep 15 - Oct 20, 2026" · "Dec 28, 2026 - Jan 05, 2027" · "Oct 03, 2026"
function parseRange(text) {
  const s = String(text || '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  const mon = w => MONTHS[String(w || '').slice(0, 4).toLowerCase().replace(/[^a-z]/g, '')] || MONTHS[String(w || '').slice(0, 3).toLowerCase()];
  let m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2})(?:, (\d{4}))? - (?:([A-Za-z]{3,9})\.? )?(\d{1,2}), (\d{4})$/);
  if (m) {
    const y2 = +m[6], m1 = mon(m[1]), m2 = m[4] ? mon(m[4]) : m1;
    const y1 = m[3] ? +m[3] : m1 > m2 ? y2 - 1 : y2;
    if (!m1 || !m2) return null;
    return { start: { y: y1, m: m1, d: +m[2] }, end: { y: y2, m: m2, d: +m[5] } };
  }
  m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/);
  if (m && mon(m[1])) { const d = { y: +m[3], m: mon(m[1]), d: +m[2] }; return { start: d, end: d }; }
  return null;
}

// ---------- sources ----------
// get(url, { json: true }) → parsed JSON | null ; get(url) → { status, text }
const SOURCES = [
  {
    id: 'devpost', name: 'Devpost', kind: 'api', enabled: true,
    async fetch(get, st) {
      const out = []; const maxPages = Number(process.env.DEVPOST_PAGES) || 12;
      for (let page = 1; page <= maxPages; page++) {
        const j = await get(`https://devpost.com/api/hackathons?status[]=upcoming&status[]=open&page=${page}`, { json: true });
        const list = j?.hackathons || [];
        for (const h of list) {
          if (h.invite_only) { st.skip('invite only'); continue; }
          const loc = h.displayed_location || {};
          const online = /online/i.test(loc.location || '') || loc.icon === 'globe';
          const range = parseRange(h.submission_period_dates);
          out.push({
            id: h.id || h.url, title: h.title, url: h.url, range, mode: online ? 'online' : 'offline', location: loc.location,
            org: h.organization_name, prize: decode(String(h.prize_amount || '').replace(/<[^>]*>/g, '')) || null, themes: (h.themes || []).map(t => t.name).filter(Boolean),
            registrations: h.registrations_count, free: true,
          });
        }
        const total = j?.meta?.total_count, per = j?.meta?.per_page || list.length;
        if (!list.length || (total && page * per >= total)) break;
      }
      return out;
    },
  },
  {
    id: 'unstop', name: 'Unstop', kind: 'api', enabled: true,
    async fetch(get) {
      const out = []; const maxPages = Number(process.env.UNSTOP_PAGES) || 6;
      for (let page = 1; page <= maxPages; page++) {
        const j = await get(`https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&page=${page}&per_page=30&oppstatus=open`, { json: true });
        const d = j?.data || {}; const list = d.data || [];
        for (const h of list) {
          const a = h.address_with_country_logo || {};
          const fee = pick(h, 'regnRequirements.reg_fee', 'regn_fee', 'fees');
          out.push({
            id: h.id, title: h.title, url: h.public_url ? `https://unstop.com/${String(h.public_url).replace(/^\//, '')}` : h.seo_url,
            start: h.start_date, end: h.end_date, mode: /online/i.test(h.region || '') ? 'online' : /hybrid/i.test(h.region || '') ? 'hybrid' : 'offline',
            city: a.city, location: [a.address, a.city, a.state].filter(Boolean).join(', '),
            org: pick(h, 'organisation.name', 'organisation_name'), prize: typeof h.prizes_total === 'string' ? h.prizes_total : null,
            deadline: pick(h, 'regnRequirements.end_regn_dt', 'end_regn_dt'), free: fee == null ? null : !(+fee > 0),
          });
        }
        if (!list.length || (d.last_page && page >= d.last_page)) break;
      }
      return out;
    },
  },
  {
    id: 'devfolio', name: 'Devfolio', kind: 'api', enabled: true,
    async fetch(get, st) {
      // 1) the listing page embeds its data as Next.js JSON (__NEXT_DATA__)
      let items = [];
      const r = await get('https://devfolio.co/hackathons');
      const m = r?.status === 200 && r.text.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
      if (m) { try { items = findObjects(JSON.parse(m[1]), o => o.slug && (o.name || o.title) && (o.starts_at || o.ends_at)); } catch { st.error('Devfolio page JSON could not be read'); } }
      // 2) fallback: the public listing API the site uses
      if (!items.length) {
        for (let page = 1; page <= 5; page++) {
          const j = await get(`https://api.devfolio.co/api/hackathons?page=${page}`, { json: true });
          const list = j?.result || j?.hackathons || j?.data || [];
          if (!Array.isArray(list) || !list.length) break;
          items.push(...list);
        }
      }
      const seen = new Set();
      return items.filter(h => !seen.has(h.slug) && seen.add(h.slug)).map(h => {
        const set = h.hackathon_setting || h.settings || {};
        return {
          id: h.slug, title: h.name || h.title, url: `https://${h.slug}.devfolio.co/`, start: h.starts_at, end: h.ends_at,
          mode: set.is_hybrid || h.is_hybrid ? 'hybrid' : h.is_online ? 'online' : 'offline',
          city: str(h.city), location: str(h.location), deadline: set.reg_ends_at || h.reg_ends_at || null,
          themes: (h.themes || []).map(t => str(t.theme || t)).filter(t => t && !/no restrictions/i.test(t)), free: true,
          prize: null, org: null,
        };
      });
    },
  },
  {
    id: 'hackerearth', name: 'HackerEarth', kind: 'api', enabled: true,
    async fetch(get) {
      const out = [];
      for (const status of ['ONGOING', 'UPCOMING']) {
        const j = await get(`https://www.hackerearth.com/api/community/challenges/compete/?limit=100&status=${status}`, { json: true });
        for (const h of j?.data || j?.results || []) {
          if (!/hackathon/i.test(h.type || h.challenge_type || '')) continue;
          const url = /^https?:/.test(h.url || '') ? h.url : h.url ? 'https://www.hackerearth.com' + h.url : `https://www.hackerearth.com/challenges/hackathon/${h.slug}/`;
          out.push({ id: h.slug || url, title: h.title, url, start: h.start, end: h.end, mode: !h.location || /online|virtual/i.test(h.location) ? 'online' : 'offline', location: h.location, free: true, org: h.company || null });
        }
      }
      return out;
    },
  },
  {
    id: 'hack2skill', name: 'Hack2Skill', kind: 'api', enabled: true,
    async fetch(get) {
      const from = new Date(Date.now() - 60 * DAY).toISOString(), to = new Date(Date.now() + 365 * DAY).toISOString();
      const out = [];
      for (let page = 1; page <= 3; page++) {
        const j = await get(`https://vision.hack2skill.com/api/v1/innovator/public/event/public-list?page=${page}&records=50&search=&start=${from}&end=${to}`, { json: true });
        const list = Array.isArray(j?.data) ? j.data : j?.data?.docs || [];
        for (const h of list) {
          const slug = h.eventUrl || h.configs?.slug; if (!slug) continue;
          const mode = String(h.mode || '');
          out.push({
            id: h._id || h.id || slug, title: h.title, url: /^https?:/.test(slug) ? slug : `https://vision.hack2skill.com/event/${slug}`,
            start: h.submissionStart || h.startDate || h.registrationStart, end: h.submissionEnd || h.endDate || h.registrationEnd,
            deadline: h.registrationEnd || null, mode: /virtual|online/i.test(mode) ? 'online' : /hybrid/i.test(mode) ? 'hybrid' : 'offline',
            city: str(h.city), location: [str(h.venue), str(h.city), str(h.state)].filter(Boolean).join(', '), free: /free/i.test(String(h.fee ?? h.fees ?? 'free')), org: str(h.organiser || h.organizer || h.company) || null,
          });
        }
        if (list.length < 50) break;
      }
      return out;
    },
  },
];

// depth-first search through any JSON for objects matching a test (Next.js / React Query payloads)
function findObjects(root, test, limit = 2000) {
  const out = []; const stack = [root]; let guard = 0;
  while (stack.length && guard++ < 200000 && out.length < limit) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) { for (const x of n) stack.push(x); continue; }
    if (test(n)) { out.push(n); continue; }
    for (const v of Object.values(n)) if (v && typeof v === 'object') stack.push(v);
  }
  return out;
}

// ---------- hack → aggregator record ----------
const endOfDay = p => istISO(p.y, p.m, p.d, 23, 30);
function dates(h) {
  if (h.range) return { start: istISO(h.range.start.y, h.range.start.m, h.range.start.d, 10, 0), end: endOfDay(h.range.end), allDay: true };
  const s = h.start ? parseDate(h.start) : null;
  const e = h.end ? parseDate(h.end) : null;
  if (!s && !e) return null;
  const start = s || e;
  let end = e ? (e.allDay && e.y ? endOfDay(e) : e.iso) : start.allDay && start.y ? endOfDay(start) : new Date(new Date(start.iso).getTime() + 3 * 3600000).toISOString();
  if (new Date(end) <= new Date(start.iso)) end = start.allDay && start.y ? endOfDay(start) : new Date(new Date(start.iso).getTime() + 3 * 3600000).toISOString();
  return { start: start.iso, end, allDay: start.allDay };
}

function hackToRecord(h, site) {
  const title = decode(h.title).slice(0, 140);
  if (!title || !h.url) return { skip: 'incomplete' };
  const d = dates(h); if (!d) return { skip: 'no date' };
  if (new Date(d.end).getTime() < Date.now()) return { skip: 'past' };
  let durH = (new Date(d.end) - new Date(d.start)) / 3600000;
  if (!(durH > 0)) durH = 24;
  durH = Math.min(durH, 24 * 90);
  const locText = decode([h.city, h.location].filter(Boolean).join(', '));
  const cityId = h.mode === 'online' ? null : resolveCity(decode(h.city), locText);
  let online = h.mode === 'online' || (h.mode === 'hybrid' && !cityId);
  if (!online && !cityId) return { skip: 'outside our cities' };
  const deadline = h.deadline ? parseDate(h.deadline)?.iso || null : null;
  const hack = { mode: online ? 'online' : h.mode, deadline, prize: h.prize || null, themes: (h.themes || []).slice(0, 5), registrations: Number.isFinite(+h.registrations) && h.registrations != null ? +h.registrations : null, platform: site.name };
  const bits = [hack.prize && `Prizes: ${hack.prize}`, hack.themes.length && `Themes: ${hack.themes.join(', ')}`, deadline && `Registration closes ${new Date(deadline).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}`, h.org && `By ${decode(h.org)}`].filter(Boolean);
  const base = { source: 'crawl', site: site.name, sourceId: `${site.id}:${h.id}`, url: h.url, title, category: 'hackathons', start: d.start, durH: Math.round(durH * 10) / 10, allDay: d.allDay,
    tiers: [], priceMin: h.free === true ? 0 : null, description: bits.join(' · ').slice(0, 300), organizer: h.org ? decode(h.org).slice(0, 80) : null, image: null, external: true, hack,
    links: [{ source: site.name, url: h.url, type: 'tickets' }] };
  if (online) return { record: { ...base, city: 'online', online: true, area: { name: 'Online', zone: null }, venue: 'Online', address: '', lat: null, lng: null, approxLocation: false } };
  const city = CITIES.find(c => c.id === cityId);
  const area = city.areas.find(a => locText.toLowerCase().includes(a.name.split(',')[0].toLowerCase()));
  const venue = decode(String(h.location || '').split(',')[0]).slice(0, 90) || (area ? area.name : city.short);
  return { record: { ...base, city: cityId, area: area ? { name: area.name, zone: area.zone } : { name: city.short, zone: null }, venue, address: locText.slice(0, 200), lat: area ? area.lat : city.lat, lng: area ? area.lng : city.lng, approxLocation: true } };
}

module.exports = { SOURCES, hackToRecord, parseRange, findObjects };
