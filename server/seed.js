// Generates realistic multi-source raw feeds (each with its own schema) for the
// aggregation pipeline, plus demo people. Real integrations would replace
// generateFeeds() with API pulls — the aggregator does not care where feeds come from.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CITIES, CATEGORIES, TEMPLATES, CITY_BIAS } = require('./catalog');
const { mulberry32, pick, weightedPick, istDayKey, addDaysKey, dowOfKey, istISO, pad } = require('./util');

const { DATA_DIR } = require('./db');
const SOURCES_DIR = path.join(DATA_DIR, 'sources');
const DAYS = 21;

// City names the way different platforms spell them (the aggregator must normalise these)
const CITY_SPELLINGS = {
  delhi: ['Delhi NCR', 'New Delhi', 'Delhi'], mumbai: ['Mumbai', 'Bombay', 'Mumbai'], bengaluru: ['Bengaluru', 'Bangalore', 'Bangalore'],
  hyderabad: ['Hyderabad'], chennai: ['Chennai', 'Madras'], kolkata: ['Kolkata', 'Calcutta'], pune: ['Pune'], ahmedabad: ['Ahmedabad'],
  jaipur: ['Jaipur'], chandigarh: ['Chandigarh', 'Chandigarh Tricity'], lucknow: ['Lucknow'], goa: ['Goa', 'North Goa'], kochi: ['Kochi', 'Cochin'], indore: ['Indore'],
};
const TH_CATEGORY = { music: 'Concerts', comedy: 'Stand-up Comedy', bhajan: 'Devotional', parties: 'Nightlife', theatre: 'Theatre', food: 'Food & Drinks', arts: 'Exhibitions', festivals: 'Festivals', gaming: 'Esports', screenings: 'Screenings', workshops: 'Workshops', sports: 'Sports', wellness: 'Wellness', openmic: 'Open Mic', meetups: 'Social', hackathons: 'Hackathon', networking: 'Conference' };
const DC_TRACK = { hackathons: 'Hackathon', networking: 'Startup Event', gaming: 'Esports', meetups: 'Tech Meetup', workshops: 'Workshop' };
const ML_TOPICS = { meetups: ['Community', 'Social'], openmic: ['Poetry', 'Open Mic'], wellness: ['Meditation', 'Yoga'], sports: ['Running', 'Fitness'], workshops: ['Crafts', 'Learning'], hackathons: ['Coding', 'Hackathon'], networking: ['Startups', 'Networking'], arts: ['Art', 'Heritage'], food: ['Food'], bhajan: ['Bhajan', 'Kirtan'], music: ['Music'], comedy: ['Comedy'], gaming: ['Gaming'], screenings: ['Film'], festivals: ['Festival'], parties: ['Party'], theatre: ['Theatre'] };

const ORGANIZERS = ['Funhouse Collective', 'Weekend Club', 'Local Legends', 'The Culture Co.', 'Campus Crew', 'Night Owls Ent.', 'Build Club India', 'Sangat Events', 'Good Times Society', 'Hustle House'];

function primarySource(cat) {
  if (['hackathons', 'networking'].includes(cat)) return 'devcircuit';
  if (['meetups', 'openmic', 'wellness', 'sports', 'workshops'].includes(cat)) return 'meetlocal';
  return 'tickethub';
}

function makeCanonical(todayKey, seed) {
  const rng = mulberry32(seed);
  const out = [];
  const nowHourIST = new Date(Date.now() + 330 * 60000).getUTCHours();
  const seen = new Set();
  for (const city of CITIES) {
    const count = Math.round(150 * city.weight);
    const bias = CITY_BIAS[city.id] || {};
    const catEntries = Object.entries(TEMPLATES).map(([cat, t]) => [cat, t.w * (bias[cat] || 1)]);
    for (let i = 0; i < count; i++) {
      const cat = weightedPick(rng, catEntries);
      const t = TEMPLATES[cat];
      // day selection: weekends weighted by template bias; guarantee some events today
      let dayOffset;
      if (i < 8) dayOffset = 0;
      else {
        const dayEntries = [];
        for (let d = 0; d < DAYS; d++) { const dow = dowOfKey(addDaysKey(todayKey, d)); const wkend = dow === 0 || dow === 6; dayEntries.push([d, (wkend ? t.wk : dow === 5 ? 1.4 : 1) * (d < 10 ? 1.4 : 1)]); }
        dayOffset = weightedPick(rng, dayEntries);
      }
      const dayKey = addDaysKey(todayKey, dayOffset);
      let hour = pick(rng, t.hours);
      if (dayOffset === 0 && hour <= nowHourIST) hour = Math.min(22, Math.max(nowHourIST + 1 + Math.floor(rng() * 3), 17));
      const minute = pick(rng, [0, 0, 0, 30, 30, 15, 45]);
      const area = pick(rng, city.areas);
      const title = pick(rng, t.titles).replace('{area}', area.name.split(',')[0]).replace('{city}', city.short);
      if (seen.has(`${city.id}|${dayKey}|${title}`)) continue; // one listing per title per day
      seen.add(`${city.id}|${dayKey}|${title}`);
      const [y, m, d] = dayKey.split('-').map(Number);
      const start = istISO(y, m, d, hour, minute);
      const jitter = () => (rng() - 0.5) * 0.012;
      // demand: some events are hot, a few are near sold out
      const heat = rng();
      const tiers = t.tiers.map(([name, price, cap]) => {
        const capacity = Math.max(4, Math.round(cap * (0.6 + rng() * 0.8)));
        const soldFrac = heat > 0.9 ? 0.9 + rng() * 0.09 : heat > 0.6 ? 0.45 + rng() * 0.4 : rng() * 0.45;
        const priceAdj = price === 0 ? 0 : Math.round((price * (0.8 + rng() * 0.5)) / 50) * 50 - 1;
        return { name, price: Math.max(0, priceAdj), capacity, sold: Math.floor(capacity * soldFrac) };
      });
      out.push({
        key: crypto.createHash('md5').update(`${city.id}|${dayKey}|${i}|${title}`).digest('hex').slice(0, 10),
        cat, city, area, title, start, durH: t.dur, tiers,
        venue: `${pick(rng, t.venues)}`,
        lat: area.lat + jitter(), lng: area.lng + jitter(),
        desc: t.desc, label: pick(rng, t.labels), organizer: pick(rng, ORGANIZERS),
        image: t.image && rng() < 0.45 ? t.image : null,
      });
    }
  }
  return out;
}

// Small realistic mutations so the same event looks different on each platform
function variantTitle(rng, title, area) {
  const ops = [
    s => s.toUpperCase(),
    s => `${s} | ${area.name.split(',')[0]}`,
    s => `LIVE: ${s}`,
    s => s.replace(/^The /, ''),
    s => `${s} (2026 Edition)`,
    s => s.replace(/:/, ' -'),
  ];
  return pick(rng, ops)(title);
}

function generateFeeds(seed = Date.now() % 100000) {
  const todayKey = istDayKey(new Date());
  const canon = makeCanonical(todayKey, seed);
  const rng = mulberry32(seed + 7);
  const feeds = { tickethub: [], devcircuit: [], meetlocal: [] };
  let n = 0;
  const emit = (src, c, variant) => {
    n++;
    const title = variant ? variantTitle(rng, c.title, c.area) : c.title;
    const cityName = variant ? pick(rng, CITY_SPELLINGS[c.city.id]) : CITY_SPELLINGS[c.city.id][0];
    const shift = variant && rng() < 0.3 ? 15 * 60000 * (rng() < 0.5 ? -1 : 1) : 0;
    const startMs = new Date(c.start).getTime() + shift;
    const priceBump = variant ? (rng() < 0.4 ? 100 : 0) : 0;
    if (src === 'tickethub') {
      feeds.tickethub.push({
        id: `th_${c.key}${variant ? 'v' : ''}`, event_name: title, category_name: TH_CATEGORY[c.cat], city_name: cityName,
        venue: { name: c.venue, locality: c.area.name, geo: { lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5) } },
        starts_at: new Date(startMs).toISOString(), duration_minutes: Math.round(c.durH * 60),
        price_inr_min: Math.min(...c.tiers.map(t => t.price)) + priceBump,
        ticket_types: c.tiers.map(t => ({ label: t.name, price: t.price + (t.price ? priceBump : 0), qty_total: t.capacity, qty_sold: t.sold })),
        url: `https://tickethub.example/e/th_${c.key}`, synopsis: c.desc, promoter: c.organizer, poster: c.image,
      });
    } else if (src === 'devcircuit') {
      const d = new Date(startMs + 330 * 60000);
      const main = c.tiers[0];
      feeds.devcircuit.push({
        slug: `dc-${c.key}${variant ? '-x' : ''}`, title, track: DC_TRACK[c.cat] || 'Event',
        location: `${c.venue}, ${c.area.name}, ${cityName}`,
        date: `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`, start_time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
        hours: c.durH, registration_fee: main.price, seats: main.capacity, seats_filled: main.sold,
        extra_passes: c.tiers.slice(1).map(t => ({ pass: t.name, fee: t.price, seats: t.capacity, filled: t.sold })),
        url: `https://devcircuit.example/${c.key}`, about: c.desc, host: c.organizer, coords: [+c.lat.toFixed(5), +c.lng.toFixed(5)], cover: c.image,
      });
    } else {
      const main = c.tiers[0];
      feeds.meetlocal.push({
        uid: `ml${c.key}${variant ? 'b' : ''}`, name: title, group_name: c.organizer, city: cityName,
        where: `${c.venue} · ${c.area.name}`, lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), when: startMs, duration_h: c.durH,
        cost: main.price, rsvp_limit: main.capacity, rsvp_count: main.sold, topics: ML_TOPICS[c.cat] || [], link: `https://meetlocal.example/m/${c.key}`,
        details: c.desc,
      });
    }
  };
  for (const c of canon) {
    const primary = primarySource(c.cat);
    emit(primary, c, false);
    // cross-listing on other platforms (these create duplicates the aggregator must merge)
    const others = ['tickethub', 'devcircuit', 'meetlocal'].filter(s => s !== primary);
    const r = rng();
    if (r < 0.28) emit(pick(rng, others), c, true);
    if (r < 0.06) emit(others.find(s => s !== others[0]) || others[0], c, true);
    if (r > 0.97) emit(primary, c, true); // same platform double-posting
  }
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
  for (const [name, rows] of Object.entries(feeds)) fs.writeFileSync(path.join(SOURCES_DIR, `${name}.json`), JSON.stringify({ source: name, fetchedAt: new Date().toISOString(), items: rows }, null, 1));
  return { canonical: canon.length, raw: n };
}

const FIRST = ['Aarav', 'Ananya', 'Rohan', 'Isha', 'Kabir', 'Meera', 'Vihaan', 'Saanvi', 'Arjun', 'Diya', 'Aditya', 'Priya', 'Karan', 'Riya', 'Siddharth', 'Tara', 'Yash', 'Nisha', 'Dev', 'Zoya', 'Neel', 'Aisha', 'Ishaan', 'Kavya', 'Rahul', 'Sneha', 'Aman', 'Pooja', 'Varun', 'Ira'];
const LAST = ['Sharma', 'Iyer', 'Khan', 'Reddy', 'Gupta', 'Das', 'Singh', 'Nair', 'Mehta', 'Kapoor', 'Bose', 'Patel', 'Joshi', 'Verma', 'Menon'];

// Demo people: bots that auto-accept friend requests and react to group plans
function seedPeople(db, auth) {
  const rng = mulberry32(42);
  const catIds = CATEGORIES.map(c => c.id);
  const cityPlan = ['delhi', 'delhi', 'delhi', 'delhi', 'delhi', 'delhi', 'delhi', 'mumbai', 'mumbai', 'mumbai', 'bengaluru', 'bengaluru', 'bengaluru', 'hyderabad', 'pune', 'pune', 'kolkata', 'chennai', 'goa', 'jaipur', 'lucknow', 'chandigarh', 'delhi', 'mumbai', 'bengaluru', 'kochi', 'indore', 'ahmedabad'];
  const bots = cityPlan.map((city, i) => {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const interests = [...new Set([pick(rng, catIds), pick(rng, catIds), pick(rng, catIds)])];
    return auth.createUser(db, { name, username: name.split(' ')[0].toLowerCase() + (i + 1), email: `${name.split(' ')[0].toLowerCase()}${i + 1}@funillion.demo`, password: crypto.randomBytes(12).toString('hex'), city, interests, bot: true });
  });
  // demo account
  const demo = auth.createUser(db, { name: 'Demo User', username: 'demo', email: 'demo@funillion.app', password: 'funillion', city: 'delhi', interests: ['comedy', 'music', 'hackathons', 'bhajan'] });
  // friendships: demo ↔ delhi bots + 2 others; bots ↔ bots in same city
  const friend = (a, b) => { if (a.id === b.id) return; if (!a.friends.includes(b.id)) a.friends.push(b.id); if (!b.friends.includes(a.id)) b.friends.push(a.id); };
  bots.filter(b => b.city === 'delhi').forEach(b => friend(demo, b));
  friend(demo, bots.find(b => b.city === 'mumbai')); friend(demo, bots.find(b => b.city === 'bengaluru'));
  for (const a of bots) for (const b of bots) if (a.id < b.id && a.city === b.city && rng() < 0.6) friend(a, b);
  seedBotActivity(db, 42);
  // a ready-made group for the demo account
  const delhiBots = bots.filter(b => b.city === 'delhi').slice(0, 3);
  const upcoming = Object.values(db.events).filter(e => e.city === 'delhi' && new Date(e.start) > new Date()).sort((a, b) => a.start.localeCompare(b.start));
  const g = { id: 'g_' + crypto.randomBytes(5).toString('hex'), name: 'Weekend Squad', ownerId: demo.id, members: [demo.id, ...delhiBots.map(b => b.id)], city: 'delhi', inviteCode: crypto.randomBytes(4).toString('hex'), createdAt: new Date().toISOString(), candidates: [], messages: [], finalEventId: null };
  for (const e of upcoming.filter(e => ['comedy', 'music', 'parties', 'bhajan'].includes(e.category)).slice(0, 3)) {
    g.candidates.push({ eventId: e.id, addedBy: delhiBots[0].id, votes: delhiBots.filter(() => rng() < 0.6).map(b => b.id), at: new Date().toISOString() });
  }
  g.messages.push({ userId: delhiBots[0].id, text: 'Is weekend kuch plan karte hain? Maine 3 options daale hain 👇', at: new Date().toISOString() });
  g.messages.push({ userId: delhiBots[1].id, text: 'Comedy wala sahi lag raha hai 😂', at: new Date().toISOString() });
  db.groups[g.id] = g;
}

// bots save / mark interested on events in their city so "friends interested" is alive
function seedBotActivity(db, seed) {
  const rng = mulberry32(seed + 99);
  const byCity = {};
  for (const e of Object.values(db.events)) (byCity[e.city] ||= []).push(e);
  for (const u of Object.values(db.users).filter(u => u.bot)) {
    const pool = (byCity[u.city] || []).filter(e => new Date(e.start) > new Date());
    const liked = pool.filter(e => u.interests.includes(e.category));
    for (let k = 0; k < 8; k++) {
      const e = rng() < 0.75 && liked.length ? pick(rng, liked) : pick(rng, pool);
      if (!e) continue;
      const type = rng() < 0.5 ? 'interested' : 'save';
      db.interactions.push({ userId: u.id, eventId: e.id, type, at: new Date().toISOString() });
      if (type === 'save') { (db.saves[u.id] ||= []); if (!db.saves[u.id].includes(e.id)) db.saves[u.id].push(e.id); }
    }
  }
}

module.exports = { generateFeeds, seedPeople, seedBotActivity, SOURCES_DIR };
