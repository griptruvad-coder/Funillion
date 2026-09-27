// AI Plan My Day
// parse(): natural language (English + Hinglish) -> constraints
// optimize(): picks the best sequence of events under budget, time, travel and group-size constraints
// Optional: if ANTHROPIC_API_KEY is set, Claude parses the request first (heuristics remain the fallback).
const { CITIES, CATEGORIES } = require('./catalog');
const { istDayKey, addDaysKey, dowOfKey, istHour, haversineKm } = require('./util');
const { affinity, friendSignals, personalScore, isSoldOut } = require('./feed');

const DAY_WORDS = [
  [0, ['sunday', 'sun', 'ravivar', 'itvaar', 'itwar', 'raviwar']], [1, ['monday', 'mon', 'somvar', 'somwar']], [2, ['tuesday', 'tue', 'tues', 'mangalvar', 'mangalwar']],
  [3, ['wednesday', 'wed', 'budhvar', 'budhwar']], [4, ['thursday', 'thu', 'thurs', 'guruvar', 'guruwar', 'veervar']], [5, ['friday', 'fri', 'shukravar', 'shukrawar']],
  [6, ['saturday', 'sat', 'shanivar', 'shaniwar']],
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CAT_WORDS = {
  comedy: ['comedy', 'standup', 'stand-up', 'stand up', 'hasi', 'hasna', 'funny', 'laugh', 'roast', 'improv'],
  music: ['music', 'concert', 'gig', 'gaana', 'gaane', 'band', 'live music', 'jazz', 'sufi', 'ghazal', 'indie'],
  hackathons: ['hackathon', 'hack', 'coding', 'code', 'build'],
  bhajan: ['bhajan', 'kirtan', 'satsang', 'bhakti', 'devotional'],
  parties: ['party', 'club', 'clubbing', 'dance', 'dj', 'rave', 'nightlife', 'techno'],
  meetups: ['meetup', 'meet people', 'new people', 'book club', 'board game', 'community'],
  workshops: ['workshop', 'pottery', 'class', 'learn', 'masterclass'],
  openmic: ['open mic', 'poetry', 'shayari', 'storytelling'],
  theatre: ['theatre', 'theater', 'play', 'natak', 'drama'],
  food: ['food', 'brunch', 'dinner', 'khana', 'eat', 'biryani', 'beer', 'coffee', 'street food', 'tasting'],
  arts: ['art', 'museum', 'heritage', 'exhibition', 'gallery', 'culture'],
  sports: ['sports', 'run', 'football', 'cricket', 'cycling', 'fitness', 'pickleball', 'trek'],
  festivals: ['fest', 'festival', 'mela', 'garba', 'bazaar', 'flea'],
  networking: ['startup', 'networking', 'pitch', 'founder', 'investor'],
  gaming: ['gaming', 'game', 'esports', 'valorant', 'bgmi', 'fifa', 'chess'],
  wellness: ['yoga', 'meditation', 'wellness', 'sound bath', 'breathwork', 'relax'],
  screenings: ['movie', 'film', 'screening', 'cinema', 'match screening'],
};
const VIBES = {
  date: { words: ['date', 'couple', 'romantic', 'gf', 'bf', 'girlfriend', 'boyfriend', 'partner', 'wife', 'husband'], cats: ['comedy', 'screenings', 'food', 'music', 'theatre', 'arts', 'openmic'], people: 2 },
  chill: { words: ['chill', 'relax', 'sukoon', 'calm', 'peaceful', 'lowkey', 'low-key'], cats: ['openmic', 'arts', 'screenings', 'food', 'wellness', 'music'] },
  energy: { words: ['masti', 'high energy', 'wild', 'crazy', 'lit', 'dhamaal', 'turn up'], cats: ['parties', 'music', 'gaming', 'sports', 'festivals', 'bhajan'] },
  nerd: { words: ['nerdy', 'tech', 'geek', 'career'], cats: ['hackathons', 'meetups', 'networking', 'workshops'] },
  family: { words: ['family', 'parents', 'mummy', 'papa', 'kids', 'bachche'], cats: ['festivals', 'food', 'arts', 'theatre', 'bhajan', 'screenings'] },
};
const TIME_WORDS = [
  [['morning', 'subah', 'savere', 'breakfast'], 7, 12], [['afternoon', 'dopahar', 'lunch'], 12, 17],
  [['evening', 'shaam', 'sham', 'sundown', 'sunset'], 17, 23], [['night', 'raat', 'tonight', 'late night', 'midnight'], 19, 26],
  [['full day', 'pura din', 'whole day', 'all day', 'din bhar'], 9, 24],
];
const MUST_STAY = new Set(['theatre', 'screenings', 'comedy', 'workshops', 'openmic']);

function parse(query, user) {
  const q = ' ' + String(query || '').toLowerCase().replace(/[’']/g, '') + ' ';
  const has = w => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(q);
  const c = { raw: query, city: user?.city || 'delhi', people: 1, budget: null, date: null, from: null, to: null, zone: null, area: null, categories: [], exclude: [], vibe: null, maxStops: 3, understood: [] };

  // city
  let cityMentioned = false;
  for (const city of CITIES) {
    const names = [city.id, city.short.toLowerCase(), city.name.toLowerCase()];
    if (city.id === 'bengaluru') names.push('bangalore', 'blr'); if (city.id === 'mumbai') names.push('bombay'); if (city.id === 'kolkata') names.push('calcutta');
    if (city.id === 'delhi') names.push('dilli', 'ncr', 'gurgaon', 'gurugram', 'noida');
    if (names.some(has)) { c.city = city.id; cityMentioned = true; break; }
  }
  const city = CITIES.find(x => x.id === c.city);

  // budget: ₹1000 / rs 1500 / 1.5k / 2000 rupees / budget 800 / under 500
  let m = q.match(/(?:₹|rs\.?|inr|budget|under|below|within|max|upto|up to|andar)\s*([\d,.]+)\s*(k)?/) || q.match(/([\d,.]+)\s*(k)?\s*(?:₹|rs|rupees|rupaye|rupay|budget|inr)/);
  if (m) { let v = parseFloat(m[1].replace(/,/g, '')); if (m[2]) v *= 1000; if (v >= 0 && v < 1e6) c.budget = Math.round(v); }
  if (c.budget == null) { // bare amount like "4 log 5000"
    for (const mm of q.matchAll(/(\d[\d,.]*)(k?)\s*([a-z]*)/g)) {
      if (['am', 'pm', 'baje', 'log', 'people', 'ppl', 'friends', 'km', 'min', 'mins', 'st', 'nd', 'rd', 'th'].includes(mm[3]) || MONTHS.includes(mm[3])) continue;
      const v = parseFloat(mm[1].replace(/,/g, '')) * (mm[2] ? 1000 : 1);
      if (v >= 100) { c.budget = Math.round(v); break; }
    }
  }
  if (/\bfree\b|muft|free mein|no money/.test(q) && c.budget == null) c.budget = 0;

  // people
  if ((m = q.match(/(\d+)\s*(?:friends|dost|doston|buddies)/))) c.people = +m[1] + 1;
  else if ((m = q.match(/(\d+)\s*(?:people|log|logo|ppl|persons|of us|members|jan)/))) c.people = +m[1];
  else if ((m = q.match(/(?:group of|squad of|team of)\s*(\d+)/))) c.people = +m[1];
  if (/\b(solo|alone|akela|akeli|myself)\b/.test(q)) c.people = 1;

  // vibe
  for (const [name, v] of Object.entries(VIBES)) if (v.words.some(has)) { c.vibe = name; if (v.people && c.people === 1) c.people = v.people; break; }

  // date
  const today = istDayKey(new Date());
  const todayDow = dowOfKey(today);
  if (/\b(today|aaj|tonight|abhi)\b/.test(q)) c.date = today;
  else if (/\b(tomorrow|kal|tmrw|tmr)\b/.test(q)) c.date = addDaysKey(today, 1);
  else if (/day after tomorrow|parso/.test(q)) c.date = addDaysKey(today, 2);
  else if (/weekend/.test(q)) c.date = todayDow === 6 || todayDow === 0 ? today : addDaysKey(today, 6 - todayDow);
  let namedDay = false;
  if (!c.date) for (const [dow, words] of DAY_WORDS) if (words.some(has)) { c.date = addDaysKey(today, (dow - todayDow + 7) % 7); namedDay = true; break; }
  if (!c.date && (m = q.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/))) {
    const y = +today.slice(0, 4), mo = MONTHS.indexOf(m[2]) + 1;
    let key = `${y}-${String(mo).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`; if (key < today) key = `${y + 1}${key.slice(4)}`; c.date = key;
  }
  if (!c.date) c.date = today;

  // time window
  for (const [words, from, to] of TIME_WORDS) if (words.some(has)) { c.from = from; c.to = to; break; }
  if ((m = q.match(/(?:after|baad|from|se)\s*(\d{1,2})(?::(\d\d))?\s*(am|pm|baje)?/)) || (m = q.match(/(\d{1,2})(?::(\d\d))?\s*(am|pm|baje)\s*(?:ke baad|onwards|se)/))) {
    let h = +m[1]; if ((m[3] === 'pm' || (m[3] === 'baje' && h < 11)) && h < 12) h += 12; c.from = h + (+m[2] || 0) / 60; c.to = c.to && c.to > c.from ? c.to : 26;
  }
  if ((m = q.match(/(?:before|till|until|tak)\s*(\d{1,2})\s*(am|pm|baje)?/))) { let h = +m[1]; if ((m[2] === 'pm' || m[2] === 'baje') && h < 12) h += 12; if (m[2] === 'am' && h < 6) h += 24; c.to = h; if (c.from == null) c.from = 9; }
  if (c.from == null) { c.from = 9; c.to = 26; }
  // "Sunday morning" asked on Sunday afternoon means next Sunday
  const nowH = istHour(new Date());
  if (namedDay && c.date === today && c.to <= nowH + 0.5) c.date = addDaysKey(today, 7);

  // area / zone — look in the chosen city first, then everywhere (so "bandra" switches to Mumbai)
  const GENERIC = new Set(['sector', 'north', 'south', 'east', 'west', 'new', 'old', 'lower', 'city', 'road', 'central', 'fort', 'law', 'park', 'college', 'industrial', 'vijay', 'mg']);
  const findArea = cty => cty.areas.find(a => has(a.name.split(',')[0].toLowerCase())) || cty.areas.find(a => { const w = a.name.split(/[ ,]/)[0].toLowerCase(); return w.length >= 4 && !GENERIC.has(w) && has(w); });
  let area = city && findArea(city);
  if (!area && !cityMentioned) for (const other of CITIES) { const a = findArea(other); if (a) { area = a; c.city = other.id; break; } }
  if (area) { c.area = area.name; c.zone = area.zone; }
  else {
    const zm = q.match(/\b(south|north|east|west|central)\b/);
    if (zm) c.zone = zm[1];
    if (c.city === 'delhi' && /gurgaon|gurugram|noida/.test(q)) c.zone = 'ncr';
  }

  // categories + exclusions
  for (const [cat, words] of Object.entries(CAT_WORDS)) {
    const neg = words.some(w => new RegExp(`(no|not|without|nahi|bina)\\s+${w}`).test(q));
    if (neg) c.exclude.push(cat); else if (words.some(has)) c.categories.push(cat);
  }
  if (/no alcohol|sober|daaru nahi|no drinks/.test(q)) c.exclude.push('parties');
  if ((m = q.match(/(\d)\s*(?:events|stops|things|cheezein|plans)/))) c.maxStops = Math.min(5, Math.max(1, +m[1]));
  if (/(one|1|ek)\s+(event|plan|thing)/.test(q)) c.maxStops = 1;
  return c;
}

// Optional LLM parse. Only runs with ANTHROPIC_API_KEY; any failure falls back to heuristics.
async function llmParse(query, base) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const sys = `You convert an Indian user's plan request (English or Hinglish) into JSON constraints. Today (IST) is ${istDayKey(new Date())}. Valid cities: ${CITIES.map(c => c.id).join(', ')}. Valid categories: ${CATEGORIES.map(c => c.id).join(', ')}. Zones: north,south,east,west,central,ncr. Respond with ONLY JSON: {"city":string|null,"budget":number|null (total rupees for whole group),"people":number|null,"date":"YYYY-MM-DD"|null,"from":hour 0-26|null,"to":hour 0-26|null,"zone":string|null,"categories":string[],"exclude":string[],"maxStops":number|null}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.FUNILLION_MODEL || 'claude-sonnet-5', max_tokens: 300, system: sys, messages: [{ role: 'user', content: query }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const out = { ...base, parser: 'claude' };
    if (CITIES.some(c => c.id === j.city)) out.city = j.city;
    if (Number.isFinite(j.budget)) out.budget = j.budget;
    if (Number.isFinite(j.people) && j.people > 0) out.people = j.people;
    if (/^\d{4}-\d\d-\d\d$/.test(j.date || '')) out.date = j.date;
    if (Number.isFinite(j.from)) out.from = j.from; if (Number.isFinite(j.to)) out.to = j.to;
    if (j.zone) out.zone = j.zone;
    const valid = new Set(CATEGORIES.map(c => c.id));
    if (Array.isArray(j.categories)) out.categories = j.categories.filter(x => valid.has(x));
    if (Array.isArray(j.exclude)) out.exclude = j.exclude.filter(x => valid.has(x));
    if (Number.isFinite(j.maxStops)) out.maxStops = Math.min(5, Math.max(1, j.maxStops));
    return out;
  } catch { return null; } finally { clearTimeout(timer); }
}

function travelMinutes(a, b, city) {
  const km = haversineKm(a, b) * 1.35; // road factor
  if (km < 1.2) return { minutes: Math.round(km / 4.5 * 60) + 3, km, mode: 'Walk' };
  return { minutes: Math.round((km / (city?.speed || 18)) * 60 + 10), km, mode: km < 6 ? 'Auto / cab' : 'Metro / cab' };
}

function cheapestTier(ev, people) {
  return ev.tiers.filter(t => t.capacity - t.sold >= people).sort((a, b) => a.price - b.price)[0] || null;
}

function optimize(db, user, c) {
  const city = CITIES.find(x => x.id === c.city);
  const notes = [];
  const ctx = user ? { user, aff: affinity(db, user), friends: friendSignals(db, user) } : { aff: null };
  const vibeCats = c.vibe ? VIBES[c.vibe].cats : [];

  const gather = (dateKey, from, to, useZone) => Object.values(db.events).filter(e => {
    if (e.city !== c.city || e.status !== 'live' || isSoldOut(e)) return false;
    if (istDayKey(e.start) !== dateKey) return false;
    const h = istHour(e.start);
    if (h < from || h >= to) return false;
    if (new Date(e.start) < Date.now() - 15 * 60000) return false;
    if (c.exclude.includes(e.category)) return false;
    if (e.durH > 8 && !c.categories.includes(e.category)) return false; // skip 24h hackathons unless asked
    if (useZone && c.zone && e.zone !== c.zone) return false;
    if (!cheapestTier(e, c.people)) return false;
    return true;
  });

  let date = c.date, from = c.from, to = c.to;
  let cands = gather(date, from, to, true);
  if (cands.length < 4 && c.zone) { const wide = gather(date, from, to, false); if (wide.length > cands.length) { notes.push(`Only ${cands.length} event${cands.length === 1 ? '' : 's'} in ${c.area || c.zone + ' ' + city.short} — added nearby areas too.`); cands = wide; } }
  if (!cands.length && (from > 9 || to < 26)) { cands = gather(date, 9, 26, false); if (cands.length) { notes.push('Nothing in that time window — widened to the whole day.'); from = 9; to = 26; } }
  if (!cands.length) {
    for (let d = 1; d <= 7 && !cands.length; d++) { const k = addDaysKey(c.date, d); cands = gather(k, c.from, c.to, false); if (cands.length) { notes.push(`No events on ${fmtDay(c.date)} matched — showing ${fmtDay(k)} instead.`); date = k; } }
  }

  if (!cands.length) notes.push(`No events are listed in ${city.short} around ${fmtDay(c.date)} yet — try a date in the next three weeks.`);
  // asked for a specific kind of event but none on that day? jump to the next day that has one
  if (c.categories.length && !cands.some(e => c.categories.includes(e.category))) {
    const label = CATEGORIES.find(x => x.id === c.categories[0])?.label || 'that';
    outer: for (const [wf, wt] of [[from, to], [0, 30]]) for (let d = 1; d <= 20; d++) {
      const k = addDaysKey(date, d);
      if (gather(k, wf, wt, false).some(e => c.categories.includes(e.category))) {
        notes.push(`No ${label.toLowerCase()} left on ${fmtDay(date)} — jumped to ${fmtDay(k)}, the next day with one.`);
        date = k; from = wf; to = wt; cands = gather(k, wf, wt, false); break outer;
      }
    }
  }

  const scored = cands.map(e => {
    const ps = personalScore(e, ctx);
    let s = ps.score;
    const why = [...ps.reasons];
    if (c.categories.includes(e.category)) { s += 0.6; why.unshift('Matches what you asked for'); }
    else if (c.categories.length) s -= 0.15;
    if (vibeCats.includes(e.category)) { s += 0.25; if (!c.categories.length) why.unshift(`Fits a ${c.vibe === 'date' ? 'date' : c.vibe} vibe`); }
    if (c.zone && e.zone === c.zone) s += 0.15;
    const tier = cheapestTier(e, c.people);
    return { e, s, why: [...new Set(why)].slice(0, 3), tier, cost: tier.price * c.people };
  }).sort((a, b) => b.s - a.s).slice(0, 28).sort((a, b) => a.e.start.localeCompare(b.e.start));

  const budget = c.budget == null ? Infinity : c.budget;
  const stayH = (e, last) => last || MUST_STAY.has(e.category) ? e.durH : Math.min(e.durH, Math.max(1.5, e.durH * 0.6));

  // depth-first search over time-ordered sequences
  const results = [];
  function dfs(seq, cost, endMs, pos, lastLoc) {
    if (seq.length) results.push({ seq: [...seq], cost });
    if (seq.length >= c.maxStops) return;
    for (let i = pos; i < scored.length; i++) {
      const cand = scored[i];
      if (cost + cand.cost > budget) continue;
      const startMs = new Date(cand.e.start).getTime();
      const travel = lastLoc ? travelMinutes(lastLoc, cand.e, city) : { minutes: 0 };
      if (lastLoc && startMs < endMs + travel.minutes * 60000) continue;
      if (lastLoc && startMs - endMs > 4 * 3600000) continue; // don't leave people idle for 4h+
      if (seq.some(x => x.e.category === cand.e.category && seq.length < 3 && c.categories.length < 2 && x.e.category !== c.categories[0])) continue;
      const leave = startMs + stayH(cand.e, false) * 3600000;
      seq.push(cand); dfs(seq, cost + cand.cost, leave, i + 1, cand.e); seq.pop();
      if (results.length > 6000) return;
    }
  }
  dfs([], 0, 0, 0, null);

  const evaluate = r => {
    let obj = r.seq.reduce((s, x) => s + x.s, 0);
    obj += 0.12 * new Set(r.seq.map(x => x.e.category)).size;
    let travelMin = 0, idle = 0;
    for (let i = 1; i < r.seq.length; i++) {
      const a = r.seq[i - 1], b = r.seq[i];
      const t = travelMinutes(a.e, b.e, city); travelMin += t.minutes;
      const gap = (new Date(b.e.start) - (new Date(a.e.start).getTime() + stayH(a.e, false) * 3600000)) / 60000 - t.minutes;
      idle += Math.max(0, gap - 45);
    }
    obj -= travelMin * 0.004 + idle * 0.0015; // budget is a hard cap only — never nudge people to spend more
    return { ...r, obj, travelMin };
  };
  const ranked = results.map(evaluate).sort((a, b) => b.obj - a.obj);
  const plans = [];
  for (const r of ranked) {
    const ids = new Set(r.seq.map(x => x.e.id));
    if (plans.some(p => { const o = new Set(p.seq.map(x => x.e.id)); const inter = [...ids].filter(i => o.has(i)).length; return inter / Math.max(ids.size, o.size) >= 0.5; })) continue;
    plans.push(r);
    if (plans.length === 3) break;
  }
  if (budget !== Infinity && !plans.length && cands.length) notes.push(`Nothing fits ₹${budget.toLocaleString('en-IN')} for ${c.people} — try a higher budget or free events.`);
  return { constraints: { ...c, date, from, to }, notes, plans: plans.map(p => toItinerary(p, city, c, stayH)) , candidates: cands.length };
}

function fmtDay(key) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 6)).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }); }
function fmtTime(ms) { return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }); }

function toItinerary(p, city, c, stayH) {
  const steps = [];
  p.seq.forEach((x, i) => {
    const last = i === p.seq.length - 1;
    if (i > 0) {
      const prev = p.seq[i - 1];
      const t = travelMinutes(prev.e, x.e, city);
      const prevLeave = new Date(prev.e.start).getTime() + stayH(prev.e, false) * 3600000;
      const gap = (new Date(x.e.start) - prevLeave) / 60000 - t.minutes;
      steps.push({ type: 'travel', minutes: t.minutes, km: +t.km.toFixed(1), mode: t.mode, from: prev.e.area, to: x.e.area });
      if (gap >= 50) {
        const h = istHour(prevLeave);
        steps.push({ type: 'break', minutes: Math.round(gap), text: h >= 19 && h < 22.5 ? `Dinner break near ${x.e.area}` : h >= 12 && h < 15 ? `Lunch near ${x.e.area}` : `Free time — chai & wander around ${x.e.area}` });
      }
    }
    const startMs = new Date(x.e.start).getTime();
    steps.push({ type: 'event', eventId: x.e.id, title: x.e.title, category: x.e.category, venue: x.e.venue, area: x.e.area, lat: x.e.lat, lng: x.e.lng,
      start: x.e.start, arrive: fmtTime(startMs - 10 * 60000), leave: fmtTime(startMs + stayH(x.e, last) * 3600000) + (istDayKey(startMs + stayH(x.e, last) * 3600000) !== istDayKey(startMs) && istHour(startMs + stayH(x.e, last) * 3600000) > 5 ? ' (next day)' : ''), leavesEarly: !last && stayH(x.e, false) < x.e.durH,
      tierId: x.tier.id, tierName: x.tier.name, pricePerPerson: x.tier.price, cost: x.cost, why: x.why });
  });
  const cats = p.seq.map(x => CATEGORIES.find(k => k.id === x.e.category)?.label);
  return {
    title: p.seq.length === 1 ? `${cats[0]} in ${p.seq[0].e.area}` : `${cats.slice(0, 3).join(' → ')}`,
    steps, totalCost: p.cost, perPerson: Math.round(p.cost / Math.max(1, c.people)), travelMinutes: p.travelMin, stops: p.seq.length,
    starts: fmtTime(new Date(p.seq[0].e.start).getTime()),
  };
}

module.exports = { parse, llmParse, optimize, fmtDay, travelMinutes };
