// Smart Event Aggregation
// 1. Source adapters turn each platform's schema into one normalised shape
// 2. Normaliser fixes city spellings, maps areas, infers categories
// 3. Deduper finds the same real-world event across (and within) sources
// 4. Merger builds one clean listing with every source attached
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CITIES, CATEGORIES, TEMPLATES } = require('./catalog');
const { tokens, jaccard, trigramSim, haversineKm, istDayKey } = require('./util');
const { SOURCES_DIR } = require('./seed');

const SOURCE_META = {
  tickethub: { name: 'TicketHub', kind: 'Ticketing platform', trust: 3 },
  devcircuit: { name: 'DevCircuit', kind: 'Hackathon & tech platform', trust: 3 },
  meetlocal: { name: 'MeetLocal', kind: 'Community meetups', trust: 2 },
  organizer: { name: 'Organizer', kind: 'Submitted on Funillion', trust: 4 },
  import: { name: 'Web import', kind: 'Imported from organizer URL', trust: 2 },
  google: { name: 'Google Events', kind: 'Found via Google — BookMyShow, District, AllEvents & more', trust: 2 },
};

// ---------- normalisation helpers ----------
const CITY_ALIASES = {};
for (const c of CITIES) for (const a of [c.id, c.name, c.short]) CITY_ALIASES[a.toLowerCase()] = c.id; // not states: Maharashtra has both Mumbai and Pune
Object.assign(CITY_ALIASES, { 'new delhi': 'delhi', 'gurgaon': 'delhi', 'gurugram': 'delhi', 'noida': 'delhi', 'ncr': 'delhi', 'bombay': 'mumbai', 'navi mumbai': 'mumbai', 'thane': 'mumbai', 'bangalore': 'bengaluru', 'madras': 'chennai', 'calcutta': 'kolkata', 'cochin': 'kochi', 'ernakulam': 'kochi', 'north goa': 'goa', 'south goa': 'goa', 'panaji': 'goa', 'chandigarh tricity': 'chandigarh', 'mohali': 'chandigarh', 'secunderabad': 'hyderabad', 'cyberabad': 'hyderabad' });

function resolveCity(...hints) {
  for (const h of hints) {
    if (!h) continue;
    const s = String(h).toLowerCase();
    if (CITY_ALIASES[s]) return CITY_ALIASES[s];
    // search for any alias inside a free-text location
    const found = Object.keys(CITY_ALIASES).sort((a, b) => b.length - a.length).find(a => a.length > 3 && s.includes(a));
    if (found) return CITY_ALIASES[found];
  }
  return null;
}

function resolveArea(cityId, locality, lat, lng) {
  const city = CITIES.find(c => c.id === cityId);
  if (!city) return null;
  if (locality) {
    const l = locality.toLowerCase();
    const byName = city.areas.find(a => l.includes(a.name.split(',')[0].toLowerCase()));
    if (byName) return byName;
  }
  if (lat != null && lng != null) {
    let best = null, bd = Infinity;
    for (const a of city.areas) { const d = haversineKm({ lat, lng }, a); if (d < bd) { bd = d; best = a; } }
    if (bd < 25) return best;
  }
  return city.areas[0];
}

const CATEGORY_RULES = [
  ['bhajan', /bhajan|kirtan|satsang|bhakti|devotional|ram dhun/i],
  ['hackathons', /hackathon|hack\b|buildathon|code sprint|hack sprint|hack night|\bhack/i],
  ['wellness', /laughter yoga|yoga|meditation|breathwork|sound bath|reiki|wellness|mindful|journaling/i],
  ['comedy', /comedy|stand-?up|roast|improv|laugh|jokes/i],
  ['openmic', /open mic|poetry|shayari|spoken word|storytelling|kavi/i],
  ['parties', /party|nightlife|rave|techno|disco|club night|dj\b|ladies night|house sundays|sundowner/i],
  ['gaming', /esports|valorant|bgmi|fifa|tekken|lan party|arcade|chess|gaming/i],
  ['screenings', /screening|movie|film|cinema|documentary/i],
  ['theatre', /theatre|theater|\bplay\b|drama|mime|shakespeare/i],
  ['festivals', /festival|fest\b|mela|garba|puja|bazaar|flea|navratri|diwali/i],
  ['networking', /startup|pitch|founder|vc\b|networking|conference|summit|career fair|demo day|leaders/i],
  ['workshops', /workshop|masterclass|class\b|101|learn|craft/i],
  ['sports', /run\b|5k|marathon|football|cricket|cycling|pickleball|badminton|climbing|trek|sports|fitness/i],
  ['food', /food|tasting|beer|biryani|chef|coffee|thali|market morning|crawl|bite of/i],
  ['arts', /art|heritage|exhibition|museum|gallery|kathak|dance recital|zine/i],
  ['meetups', /meetup|meet\b|club|social|community|book|board games|exchange/i],
  ['music', /concert|live|music|band|jazz|sufi|ghazal|unplugged|rock|hip-hop|bass|sound/i],
];
// every keyword must start at a word boundary ("rave" must not match "travellers")
const BOUNDED_RULES = CATEGORY_RULES.map(([cat, re]) => [cat, new RegExp(`\\b(?:${re.source})`, 'i')]);
function inferCategory(...texts) {
  const joined = texts.filter(Boolean).join(' | ');
  for (const [cat, re] of BOUNDED_RULES) if (re.test(joined)) return cat;
  return 'meetups';
}

// ---------- adapters: raw source row -> normalised record ----------
const adapters = {
  tickethub(row) {
    const city = resolveCity(row.city_name, row.venue?.locality);
    const area = resolveArea(city, row.venue?.locality, row.venue?.geo?.lat, row.venue?.geo?.lon);
    return {
      source: 'tickethub', sourceId: row.id, url: row.url, title: row.event_name,
      category: inferCategory(row.category_name, row.event_name), city, area,
      venue: row.venue?.name, lat: row.venue?.geo?.lat ?? area?.lat, lng: row.venue?.geo?.lon ?? area?.lng,
      start: new Date(row.starts_at).toISOString(), durH: (row.duration_minutes || 120) / 60,
      tiers: (row.ticket_types || []).map(t => ({ name: t.label, price: t.price, capacity: t.qty_total, sold: t.qty_sold })),
      priceMin: row.price_inr_min, description: row.synopsis, organizer: row.promoter, image: row.poster || null,
    };
  },
  devcircuit(row) {
    const [dd, mm, yyyy] = row.date.split('-').map(Number);
    const [hh, mi] = row.start_time.split(':').map(Number);
    const start = new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi) - 330 * 60000).toISOString();
    const parts = row.location.split(',').map(s => s.trim());
    const city = resolveCity(parts[parts.length - 1], row.location);
    const [lat, lng] = row.coords || [];
    const area = resolveArea(city, parts.slice(1, -1).join(', '), lat, lng);
    const tiers = [{ name: row.registration_fee ? 'Registration' : 'Free Registration', price: row.registration_fee, capacity: row.seats, sold: row.seats_filled },
      ...(row.extra_passes || []).map(p => ({ name: p.pass, price: p.fee, capacity: p.seats, sold: p.filled }))];
    return {
      source: 'devcircuit', sourceId: row.slug, url: row.url, title: row.title,
      category: inferCategory(row.track, row.title), city, area, venue: parts[0], lat: lat ?? area?.lat, lng: lng ?? area?.lng,
      start, durH: row.hours || 3, tiers, priceMin: Math.min(...tiers.map(t => t.price)), description: row.about, organizer: row.host, image: row.cover || null,
    };
  },
  meetlocal(row) {
    const [venue, locality] = row.where.split('·').map(s => s.trim());
    const city = resolveCity(row.city, locality);
    const area = resolveArea(city, locality, row.lat, row.lng);
    return {
      source: 'meetlocal', sourceId: row.uid, url: row.link, title: row.name,
      category: inferCategory((row.topics || []).join(' '), row.name), city, area, venue, lat: row.lat, lng: row.lng,
      start: new Date(row.when).toISOString(), durH: row.duration_h || 2,
      tiers: [{ name: row.cost ? 'RSVP (paid)' : 'Free RSVP', price: row.cost, capacity: row.rsvp_limit, sold: row.rsvp_count }],
      priceMin: row.cost, description: row.details, organizer: row.group_name, image: null,
    };
  },
};

// ---------- dedup + merge ----------
function titleQuality(t) {
  let q = 0;
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) q -= 3;
  if (/^live:/i.test(t)) q -= 1;
  if (/\(.*edition\)/i.test(t)) q -= 1;
  if (/ \| /.test(t)) q -= 1;
  return q - t.length / 200;
}

function similarity(a, b) {
  const tSim = Math.max(jaccard(tokens(a.title), tokens(b.title)), trigramSim(a.title, b.title));
  const minutes = Math.abs(new Date(a.start) - new Date(b.start)) / 60000;
  const km = a.lat != null && b.lat != null ? haversineKm(a, b) : 99;
  const vSim = trigramSim(a.venue || '', b.venue || '');
  const sameCat = a.category === b.category ? 0.1 : 0;
  // weighted score, hard constraints on time + place
  if (minutes > 90) return 0;
  if (km > 3 && vSim < 0.5) return 0;
  return tSim * 0.65 + (1 - minutes / 90) * 0.15 + Math.max(vSim, km < 1 ? 1 : 0) * 0.1 + sameCat;
}
const MATCH_THRESHOLD = 0.62;

function recompute(ev) {
  // choose the cleanest title and most trusted details across all attached sources
  const recs = ev.sources;
  const best = [...recs].sort((a, b) => titleQuality(b.title) - titleQuality(a.title))[0];
  ev.title = ev.lockedTitle || best.title;
  if (!ev.lockedTime) { ev.start = best.start; ev.end = new Date(new Date(best.start).getTime() + best.durH * 3600000).toISOString(); ev.durH = best.durH; }
  ev.description = recs.map(r => r.description || '').sort((a, b) => b.length - a.length)[0] || ev.description;
  ev.image = ev.image || recs.find(r => r.image)?.image || null;
  ev.organizer = ev.organizer || best.organizer;
  const prices = [...recs.map(r => r.priceMin), ...ev.tiers.map(t => t.price)].filter(p => Number.isFinite(p));
  ev.priceMin = ev.ticketing === 'funillion' && ev.tiers.length ? Math.min(...ev.tiers.map(t => t.price)) : prices.length ? Math.min(...prices) : null;
}

function newEventFromRecord(rec) {
  const id = 'ev_' + crypto.createHash('sha1').update(`${rec.source}:${rec.sourceId}`).digest('hex').slice(0, 10);
  const tpl = TEMPLATES[rec.category];
  const ev = {
    id, title: rec.title, category: rec.category, city: rec.city, area: rec.area?.name, zone: rec.area?.zone,
    venue: rec.venue, lat: rec.lat, lng: rec.lng, start: rec.start, durH: rec.durH,
    ticketing: rec.external ? 'external' : 'funillion', links: [], address: rec.address || null, mapsUrl: rec.mapsUrl || null, approxLocation: rec.approxLocation || false, allDay: rec.allDay || false,
    tiers: rec.external ? [] : (rec.tiers.length ? rec.tiers : [{ name: 'Entry', price: rec.priceMin || 0, capacity: 100, sold: 0 }]).map((t, i) => ({ id: `t${i}`, name: t.name, price: Math.max(0, +t.price || 0), capacity: Math.max(1, +t.capacity || 100), sold: Math.min(+t.sold || 0, +t.capacity || 100) })),
    description: rec.description || '', organizer: rec.organizer || (rec.external ? null : 'Independent organiser'), organizerUserId: rec.organizerUserId || null,
    label: (tpl?.labels?.[0]) || rec.category.toUpperCase(), tags: tpl?.tags || [], image: rec.image || null,
    sources: [], status: 'live', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stats: { views: 0, clicks: 0, saves: 0 },
  };
  return ev;
}

function attach(ev, rec) {
  const clean = { source: rec.source, sourceId: rec.sourceId, url: rec.url || null, title: rec.title, start: rec.start, durH: rec.durH, priceMin: rec.priceMin, description: rec.description, organizer: rec.organizer, image: rec.image, venue: rec.venue };
  const i = ev.sources.findIndex(s => s.source === rec.source && s.sourceId === rec.sourceId);
  if (i >= 0) ev.sources[i] = clean; else ev.sources.push(clean);
  // external booking links (BookMyShow, District…) from every source, de-duplicated
  ev.links ||= [];
  for (const l of rec.links || []) if (!ev.links.some(x => x.url === l.url)) ev.links.push(l);
  // an organiser listing the event on Funillion turns a "listed" event into a ticketed one
  if (rec.source === 'organizer' && ev.ticketing !== 'funillion') {
    ev.ticketing = 'funillion'; ev.organizer = rec.organizer || ev.organizer; ev.organizerUserId = rec.organizerUserId || ev.organizerUserId;
    ev.tiers = (rec.tiers || []).map((t, k) => ({ id: `t${k}`, name: t.name, price: Math.max(0, +t.price || 0), capacity: Math.max(1, +t.capacity || 100), sold: 0 }));
  }
  ev.ticketing ||= 'funillion';
  // richer ticket info from a source upgrades the listing, but never resets Funillion's own sales
  if (ev.ticketing === 'funillion' && !rec.external && rec.tiers && rec.tiers.length > ev.tiers.length) {
    const sold = ev.tiers.reduce((s, t) => s + (t.fsold || 0), 0);
    if (!sold) ev.tiers = rec.tiers.map((t, k) => ({ id: `t${k}`, name: t.name, price: Math.max(0, +t.price || 0), capacity: Math.max(1, +t.capacity || 100), sold: Math.min(+t.sold || 0, +t.capacity || 100) }));
  }
  ev.updatedAt = new Date().toISOString();
  recompute(ev);
}

// index for fast candidate lookup: city|day -> [eventId]
function buildBlockIndex(db) {
  const idx = new Map();
  for (const ev of Object.values(db.events)) {
    const k = `${ev.city}|${istDayKey(ev.start)}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(ev.id);
  }
  return idx;
}

// Ingest one normalised record. Returns {event, action: created|updated|merged, score?, matchedTitle?}
function ingest(db, rec, blockIdx = buildBlockIndex(db)) {
  if (!rec.city) return { action: 'skipped', reason: 'Unknown city' };
  const srcKey = `${rec.source}:${rec.sourceId}`;
  const existingId = db.sourceIndex[srcKey];
  if (existingId && db.events[existingId]) { attach(db.events[existingId], rec); return { event: db.events[existingId], action: 'updated' }; }
  // look for the same real-world event in neighbouring day blocks (handles late-night timezone edges)
  let best = null, bestScore = 0;
  const day = istDayKey(rec.start);
  for (const k of [`${rec.city}|${day}`]) {
    for (const id of blockIdx.get(k) || []) {
      const ev = db.events[id];
      const s = Math.max(similarity(rec, ev), ...ev.sources.map(src => similarity(rec, { ...src, lat: ev.lat, lng: ev.lng, category: ev.category })));
      if (s > bestScore) { bestScore = s; best = ev; }
    }
  }
  if (best && bestScore >= MATCH_THRESHOLD) {
    const before = best.title;
    attach(best, rec);
    db.sourceIndex[srcKey] = best.id;
    return { event: best, action: 'merged', score: +bestScore.toFixed(2), matchedTitle: before };
  }
  const ev = newEventFromRecord(rec);
  attach(ev, rec);
  db.events[ev.id] = ev;
  db.sourceIndex[srcKey] = ev.id;
  const k = `${rec.city}|${day}`;
  if (!blockIdx.has(k)) blockIdx.set(k, []);
  blockIdx.get(k).push(ev.id);
  return { event: ev, action: 'created' };
}

function runAggregation(db) {
  const t0 = Date.now();
  const stats = { ranAt: new Date().toISOString(), perSource: {}, raw: 0, created: 0, updated: 0, merged: 0, skipped: 0, merges: [] };
  const blockIdx = buildBlockIndex(db);
  for (const name of Object.keys(adapters)) {
    const file = path.join(SOURCES_DIR, `${name}.json`);
    if (!fs.existsSync(file)) continue;
    const feed = JSON.parse(fs.readFileSync(file, 'utf8'));
    stats.perSource[name] = { name: SOURCE_META[name].name, kind: SOURCE_META[name].kind, items: feed.items.length, fetchedAt: feed.fetchedAt };
    for (const row of feed.items) {
      stats.raw++;
      let rec; try { rec = adapters[name](row); } catch (e) { stats.skipped++; continue; }
      const r = ingest(db, rec, blockIdx);
      stats[r.action]++;
      if (r.action === 'merged' && stats.merges.length < 60) stats.merges.push({ incoming: rec.title, source: SOURCE_META[name].name, into: r.event.title, score: r.score, city: rec.city, eventId: r.event.id });
    }
  }
  stats.totalEvents = Object.keys(db.events).length;
  stats.ms = Date.now() - t0;
  db.meta.aggregation = stats;
  return stats;
}

module.exports = { runAggregation, ingest, resolveCity, resolveArea, inferCategory, SOURCE_META, similarity, buildBlockIndex };
