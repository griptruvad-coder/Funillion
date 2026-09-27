// Personalised "For You" ranking + trending shelves + Fun Score
const { CATEGORIES, CITIES } = require('./catalog');
const { istDayKey, addDaysKey, dowOfKey, istHour } = require('./util');
const { SOURCE_META } = require('./aggregator');

const WEIGHTS = { view: 0.3, click: 0.6, interested: 1.5, save: 2, book: 4, plan: 1 };
const HALF_LIFE_DAYS = 14;
const catLabel = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label]));

function fillRatio(ev) { const cap = ev.tiers.reduce((s, t) => s + t.capacity, 0); const sold = ev.tiers.reduce((s, t) => s + t.sold, 0); return cap ? sold / cap : 0; }
function isSoldOut(ev) { return ev.ticketing !== 'external' && ev.tiers.length > 0 && ev.tiers.every(t => t.sold >= t.capacity); }

function popularity(ev) {
  const f = fillRatio(ev);
  return Math.min(1, 0.55 * f + 0.25 * Math.log1p(ev.stats.saves * 3 + ev.stats.clicks) / Math.log(60) + 0.2 * Math.min(1, ev.sources.length / 3));
}
// 0–100 ranking signal shown on cards: demand + saves + freshness + cross-platform presence
function funScore(ev) {
  const hoursAway = (new Date(ev.start) - Date.now()) / 3600000;
  const fresh = hoursAway < 0 ? 0 : hoursAway < 72 ? 1 : Math.max(0, 1 - (hoursAway - 72) / 600);
  return Math.round(100 * (0.7 * popularity(ev) + 0.3 * fresh));
}

function affinity(db, user) {
  const aff = Object.fromEntries(CATEGORIES.map(c => [c.id, 0]));
  for (const c of user.interests || []) aff[c] += 3;
  const now = Date.now();
  for (const it of db.interactions) {
    if (it.userId !== user.id) continue;
    const ev = db.events[it.eventId]; if (!ev) continue;
    const ageDays = (now - new Date(it.at)) / 86400000;
    aff[ev.category] += (WEIGHTS[it.type] || 0) * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  }
  const max = Math.max(1, ...Object.values(aff));
  for (const k in aff) aff[k] /= max;
  return aff;
}

// eventId -> Set(friendId) for friends who saved/were interested/booked
function friendSignals(db, user) {
  const map = new Map();
  if (!user) return map;
  const friends = new Set(user.friends);
  for (const it of db.interactions) {
    if (!friends.has(it.userId) || !['interested', 'save', 'book'].includes(it.type)) continue;
    if (!map.has(it.eventId)) map.set(it.eventId, new Set());
    map.get(it.eventId).add(it.userId);
  }
  for (const b of Object.values(db.bookings)) if (b.status === 'confirmed' && friends.has(b.userId)) { if (!map.has(b.eventId)) map.set(b.eventId, new Set()); map.get(b.eventId).add(b.userId); }
  return map;
}

function personalScore(ev, ctx) {
  const aff = ctx.aff ? ctx.aff[ev.category] : 0.3;
  const nFriends = ctx.friends?.get(ev.id)?.size || 0;
  const pop = popularity(ev);
  const hoursAway = (new Date(ev.start) - Date.now()) / 3600000;
  const urgency = hoursAway < 0 ? 0 : hoursAway < 48 ? 1 : hoursAway < 168 ? 0.6 : 0.25;
  const score = 0.42 * aff + 0.2 * Math.min(nFriends, 3) / 3 + 0.2 * pop + 0.18 * urgency;
  const reasons = [];
  if (nFriends) reasons.push(`${nFriends} friend${nFriends > 1 ? 's' : ''} interested`);
  if (ctx.user?.interests?.includes(ev.category)) reasons.push(`You like ${catLabel[ev.category]}`);
  else if (aff > 0.5) reasons.push(`Based on your activity in ${catLabel[ev.category]}`);
  if (pop > 0.7) reasons.push(`Trending in ${CITIES.find(c => c.id === ev.city)?.short}`);
  if (hoursAway >= 0 && hoursAway < 30) reasons.push('Happening soon');
  if (ev.priceMin === 0) reasons.push('Free');
  return { score, reasons };
}

function forYou(db, user, cityId, limit = 12) {
  const ctx = { user, aff: affinity(db, user), friends: friendSignals(db, user) };
  const booked = new Set(Object.values(db.bookings).filter(b => b.userId === user.id && b.status === 'confirmed').map(b => b.eventId));
  const pool = upcoming(db, cityId).filter(e => !booked.has(e.id) && !isSoldOut(e)).map(e => ({ e, ...personalScore(e, ctx) }));
  // MMR-style diversity: penalise repeating the same category
  const picked = [], catCount = {};
  while (picked.length < limit && pool.length) {
    let bi = 0, bs = -Infinity;
    pool.forEach((p, i) => { const s = p.score - 0.1 * (catCount[p.e.category] || 0); if (s > bs) { bs = s; bi = i; } });
    const [p] = pool.splice(bi, 1);
    catCount[p.e.category] = (catCount[p.e.category] || 0) + 1;
    picked.push(p);
  }
  return picked;
}

function upcoming(db, cityId) {
  const now = Date.now();
  return Object.values(db.events).filter(e => e.status === 'live' && (!cityId || e.city === cityId) && new Date(e.end || e.start).getTime() > now && (new Date(e.start).getTime() > now - 2 * 3600000 || e.durH >= 20));
}

function weekendKeys() {
  const today = istDayKey(new Date());
  const dow = dowOfKey(today);
  if (dow === 6) return [today, addDaysKey(today, 1)];
  if (dow === 0) return [today];
  return [addDaysKey(today, 6 - dow), addDaysKey(today, 7 - dow)];
}

function trending(db, cityId) {
  const list = upcoming(db, cityId);
  const today = istDayKey(new Date()), tomorrow = addDaysKey(today, 1);
  const wk = new Set(weekendKeys());
  const byPop = arr => arr.sort((a, b) => popularity(b) - popularity(a));
  return {
    tonight: byPop(list.filter(e => istDayKey(e.start) === today && istHour(e.start) >= 16 && !isSoldOut(e))).slice(0, 10),
    weekend: byPop(list.filter(e => wk.has(istDayKey(e.start)) && !isSoldOut(e))).slice(0, 10),
    sellingFast: list.filter(e => fillRatio(e) >= 0.85 && !isSoldOut(e)).sort((a, b) => fillRatio(b) - fillRatio(a)).slice(0, 10),
    free: list.filter(e => e.priceMin === 0 && [today, tomorrow].includes(istDayKey(e.start))).slice(0, 10),
  };
}

// compact card representation
function card(db, ev, viewer, friendsMap) {
  const f = friendsMap?.get(ev.id);
  const fr = f ? [...f].slice(0, 4).map(id => db.users[id]).filter(Boolean).map(u => ({ id: u.id, name: u.name, initials: u.name.split(' ').map(s => s[0]).join(''), avatarHue: u.avatarHue })) : [];
  return {
    id: ev.id, title: ev.title, category: ev.category, city: ev.city, area: ev.area, zone: ev.zone, venue: ev.venue, lat: ev.lat, lng: ev.lng,
    start: ev.start, end: ev.end, durH: ev.durH, priceMin: ev.priceMin, label: ev.label, image: ev.image,
    fill: +fillRatio(ev).toFixed(2), soldOut: isSoldOut(ev), funScore: funScore(ev),
    sources: [...new Set(ev.sources.map(s => SOURCE_META[s.source]?.name || s.source))],
    ticketing: ev.ticketing || 'funillion', bookingSource: ev.ticketing === 'external' ? (ev.links || []).find(l => l.type === 'tickets')?.source || (ev.links || [])[0]?.source || null : null,
    approxLocation: ev.approxLocation === true || ev.approxLocation === 'failed', allDay: !!ev.allDay,
    saved: viewer ? (db.saves[viewer.id] || []).includes(ev.id) : false,
    friends: fr, friendCount: f ? f.size : 0,
  };
}

module.exports = { forYou, trending, upcoming, card, affinity, friendSignals, personalScore, popularity, funScore, fillRatio, isSoldOut, weekendKeys };
