// Funillion — India's everything-events app.
// Zero dependencies: run `node server.js` (Node 18+) and open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./server/db');
const auth = require('./server/auth');
const { CITIES, CATEGORIES } = require('./server/catalog');
const { generateFeeds, seedPeople, seedBotActivity } = require('./server/seed');
const { runAggregation, ingest, resolveArea, SOURCE_META } = require('./server/aggregator');
const feed = require('./server/feed');
const planner = require('./server/planner');
const { importFromUrl } = require('./server/importer');
const { istDayKey, addDaysKey, istHour, haversineKm } = require('./server/util');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const HOLD_MINUTES = 10;
const FEE_RATE = 0.05;

// ---------------------------------------------------------------- boot
let db = store.load();
const reseed = process.argv.includes('--reseed');
if (!db || reseed) {
  console.log('› Building a fresh Funillion database…');
  db = store.empty();
  const g = generateFeeds(20260927);
  const s = runAggregation(db);
  seedPeople(db, auth);
  console.log(`› ${g.raw} raw listings from ${Object.keys(s.perSource).length} sources → ${s.totalEvents} unique events (${s.merged} duplicates merged)`);
  store.save(db, true);
} else {
  const upcomingCount = feed.upcoming(db).length;
  if (upcomingCount < 400) {
    console.log('› Event calendar is getting old — pulling fresh feeds…');
    generateFeeds(Date.now() % 1e6);
    const s = runAggregation(db);
    seedBotActivity(db, Date.now() % 1e6);
    console.log(`› ${s.created} new events, ${s.merged} duplicates merged`);
    store.save(db, true);
  }
}

// ---------------------------------------------------------------- helpers
const send = (res, status, data, headers = {}) => {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'content-type': typeof data === 'string' && headers['content-type'] ? headers['content-type'] : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
};
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const need = user => user || fail(401, 'Please log in first');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 200_000) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}

function track(user, eventId, type) {
  const ev = db.events[eventId]; if (!ev) return;
  if (type === 'view') ev.stats.views++;
  if (type === 'click') ev.stats.clicks++;
  if (user) db.interactions.push({ userId: user.id, eventId, type, at: new Date().toISOString() });
}

function sweepHolds() {
  const now = Date.now();
  for (const b of Object.values(db.bookings)) {
    if (b.status === 'pending' && new Date(b.expiresAt).getTime() < now) {
      releaseInventory(b); b.status = 'expired';
    }
  }
}
setInterval(() => { sweepHolds(); store.save(db); }, 60000).unref();
// long-running servers (Railway) keep the calendar fresh without a restart
setInterval(() => {
  if (feed.upcoming(db).length < 400) { generateFeeds(Date.now() % 1e6); const s = runAggregation(db); seedBotActivity(db, Date.now() % 1e6); store.save(db); console.log(`› Refreshed feeds: ${s.created} new events`); }
}, 6 * 3600000).unref();
// Frontend on another domain (Netlify) proxies /api to this server, so its origin must be allowed
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).map(o => { try { return new URL(o).host; } catch { return o; } }));
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function releaseInventory(b) {
  const ev = db.events[b.eventId]; if (!ev) return;
  for (const it of b.items) { const t = ev.tiers.find(t => t.id === it.tierId); if (t) { t.sold = Math.max(0, t.sold - it.qty); t.fsold = Math.max(0, (t.fsold || 0) - it.qty); } }
}

function eventFull(ev, viewer) {
  const friendsMap = viewer ? feed.friendSignals(db, viewer) : null;
  const c = feed.card(db, ev, viewer, friendsMap);
  const city = CITIES.find(x => x.id === ev.city);
  const similar = feed.upcoming(db, ev.city).filter(e => e.id !== ev.id && e.category === ev.category).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 4).map(e => feed.card(db, e, viewer, friendsMap));
  const interested = db.interactions.filter(i => i.eventId === ev.id && i.type === 'interested');
  return {
    ...c, description: ev.description, organizer: ev.organizer, organizerUserId: ev.organizerUserId, tags: ev.tags,
    tiers: ev.tiers.map(t => ({ id: t.id, name: t.name, price: t.price, left: Math.max(0, t.capacity - t.sold), capacity: t.capacity })),
    sourceDetails: ev.sources.map(s => ({ source: s.source, name: SOURCE_META[s.source]?.name || s.source, kind: SOURCE_META[s.source]?.kind, url: s.url, title: s.title, priceMin: s.priceMin })),
    kmFromCentre: +haversineKm(ev, city).toFixed(1), cityName: city.name,
    interestedCount: new Set(interested.map(i => i.userId)).size,
    isInterested: viewer ? interested.some(i => i.userId === viewer.id) : false,
    similar,
  };
}

function filterEvents(qs, viewer) {
  const city = qs.get('city') || viewer?.city || 'delhi';
  const q = (qs.get('q') || '').toLowerCase().trim();
  const cat = qs.get('cat') || 'all';
  const when = qs.get('when') || 'all';
  const price = qs.get('price') || 'all';
  const zone = qs.get('zone') || '';
  const sort = qs.get('sort') || 'recommended';
  const today = istDayKey(new Date());
  const wk = new Set(feed.weekendKeys());
  let list = feed.upcoming(db, city === 'all' ? null : city).filter(e => {
    if (cat !== 'all' && e.category !== cat) return false;
    if (zone && e.zone !== zone) return false;
    const day = istDayKey(e.start);
    if (when === 'today' && day !== today) return false;
    if (when === 'tomorrow' && day !== addDaysKey(today, 1)) return false;
    if (when === 'weekend' && !wk.has(day)) return false;
    if (when === 'week' && day > addDaysKey(today, 7)) return false;
    if (/^\d{4}-\d\d-\d\d$/.test(when) && day !== when) return false;
    if (price === 'free' && e.priceMin !== 0) return false;
    if (/^\d+$/.test(price) && e.priceMin > Number(price)) return false;
    if (q) {
      const hay = `${e.title} ${e.venue} ${e.area} ${e.category} ${e.organizer} ${e.label} ${(e.tags || []).join(' ')} ${CATEGORIES.find(c => c.id === e.category)?.label}`.toLowerCase();
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
  if (sort === 'date') list.sort((a, b) => a.start.localeCompare(b.start));
  else if (sort === 'price') list.sort((a, b) => a.priceMin - b.priceMin || a.start.localeCompare(b.start));
  else if (sort === 'popular') list.sort((a, b) => feed.funScore(b) - feed.funScore(a));
  else if (viewer) { const ctx = { user: viewer, aff: feed.affinity(db, viewer), friends: feed.friendSignals(db, viewer) }; const sc = new Map(list.map(e => [e.id, feed.personalScore(e, ctx).score])); list.sort((a, b) => sc.get(b.id) - sc.get(a.id)); }
  else list.sort((a, b) => feed.funScore(b) - feed.funScore(a));
  return list;
}

const BOT_REPLIES = ['Main in hoon! 🙌', 'Ye wala mast lag raha hai', 'Timing thodi late hai but chalega', 'Budget me hai? Then done ✅', 'Vote kar diya 🗳️', 'Kaun kaun aa raha hai?', 'Let\'s gooo 🔥', 'Metro se aa jaunga, 20 min'];
function botsReact(group, kind, payload) {
  const bots = group.members.map(id => db.users[id]).filter(u => u?.bot);
  if (!bots.length) return;
  setTimeout(() => {
    if (!db.groups[group.id]) return;
    if (kind === 'candidate') {
      const cand = group.candidates.find(c => c.eventId === payload); const ev = db.events[payload];
      if (cand && ev) for (const b of bots) if (Math.random() < (b.interests.includes(ev.category) ? 0.85 : 0.35) && !cand.votes.includes(b.id)) cand.votes.push(b.id);
    }
    if (Math.random() < 0.6) { const b = bots[Math.floor(Math.random() * bots.length)]; group.messages.push({ userId: b.id, text: BOT_REPLIES[Math.floor(Math.random() * BOT_REPLIES.length)], at: new Date().toISOString() }); }
    store.save(db);
  }, 1500 + Math.random() * 2500);
}

function groupView(g, viewer) {
  const friendsMap = feed.friendSignals(db, viewer);
  return {
    id: g.id, name: g.name, ownerId: g.ownerId, city: g.city, inviteCode: g.inviteCode, finalEventId: g.finalEventId, createdAt: g.createdAt,
    members: g.members.map(id => auth.publicUser(db.users[id])).filter(Boolean),
    candidates: g.candidates.filter(c => db.events[c.eventId]).map(c => ({ ...feed.card(db, db.events[c.eventId], viewer, friendsMap), votes: c.votes.length, voters: c.votes.map(id => auth.publicUser(db.users[id])).filter(Boolean), myVote: c.votes.includes(viewer.id), addedBy: auth.publicUser(db.users[c.addedBy]) })).sort((a, b) => b.votes - a.votes),
    messages: g.messages.slice(-80).map(m => ({ ...m, user: auth.publicUser(db.users[m.userId]) })),
  };
}

function ics(b, ev) {
  const f = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = s => String(s || '').replace(/[,;\\]/g, m => '\\' + m).replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Funillion//EN', 'BEGIN:VEVENT', `UID:${b.id}@funillion`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(ev.start)}`, `DTEND:${f(ev.end)}`,
    `SUMMARY:${esc(ev.title)}`, `LOCATION:${esc(`${ev.venue}, ${ev.area}`)}`, `DESCRIPTION:${esc(`Ticket ${b.code} · ${b.items.map(i => `${i.qty}× ${i.name}`).join(', ')}`)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:Event in 2 hours', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

const loginAttempts = new Map();
function rateLimit(ip) {
  const now = Date.now(); const arr = (loginAttempts.get(ip) || []).filter(t => now - t < 60000); arr.push(now); loginAttempts.set(ip, arr);
  if (arr.length > 20) fail(429, 'Too many attempts — wait a minute');
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler) => {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/health', () => ({ ok: true, events: feed.upcoming(db).length, users: Object.keys(db.users).length }));
route('GET', '/api/meta', () => ({ cities: CITIES.map(({ id, name, short, state, lat, lng, areas }) => ({ id, name, short, state, lat, lng, areas: areas.map(a => ({ name: a.name, zone: a.zone })), count: feed.upcoming(db, id).length })), categories: CATEGORIES, sources: SOURCE_META, totals: { events: feed.upcoming(db).length, cities: CITIES.length } }));

// auth
route('GET', '/api/me', ({ user }) => ({ user: auth.publicUser(user, user) }));
route('POST', '/api/auth/signup', ({ body, res, ip }) => {
  rateLimit(ip);
  const err = auth.validateSignup(body); if (err) fail(400, err);
  if (auth.findByLogin(db, body.username) || auth.findByLogin(db, body.email)) fail(409, 'That username or email is already registered');
  const u = auth.createUser(db, { ...body, interests: Array.isArray(body.interests) ? body.interests : [] });
  const token = auth.createSession(db, u.id);
  res.setHeader('set-cookie', auth.sessionCookie(token, auth.SESSION_DAYS * 86400));
  return { user: auth.publicUser(u, u) };
});
route('POST', '/api/auth/login', ({ body, res, ip }) => {
  rateLimit(ip);
  const u = auth.findByLogin(db, body.login);
  if (!u || u.bot || !auth.verifyPassword(String(body.password || ''), u.salt, u.hash)) fail(401, 'Wrong username/email or password');
  res.setHeader('set-cookie', auth.sessionCookie(auth.createSession(db, u.id), auth.SESSION_DAYS * 86400));
  return { user: auth.publicUser(u, u) };
});
route('POST', '/api/auth/demo', ({ res }) => {
  const u = auth.findByLogin(db, 'demo');
  res.setHeader('set-cookie', auth.sessionCookie(auth.createSession(db, u.id), auth.SESSION_DAYS * 86400));
  return { user: auth.publicUser(u, u) };
});
route('POST', '/api/auth/logout', ({ req, res }) => {
  const m = (req.headers.cookie || '').match(/fn_session=([^;]+)/); if (m) delete db.sessions[m[1]];
  res.setHeader('set-cookie', auth.sessionCookie('', 0)); return { ok: true };
});
route('PATCH', '/api/me', ({ user, body }) => {
  need(user);
  if (body.city) { if (!CITIES.some(c => c.id === body.city)) fail(400, 'Unknown city'); user.city = body.city; }
  if (Array.isArray(body.interests)) user.interests = body.interests.filter(i => CATEGORIES.some(c => c.id === i));
  if (body.name && String(body.name).trim().length >= 2) user.name = String(body.name).trim().slice(0, 60);
  return { user: auth.publicUser(user, user) };
});

// discovery
route('GET', '/api/home', ({ user, qs }) => {
  const city = qs.get('city') || user?.city || 'delhi';
  const friendsMap = user ? feed.friendSignals(db, user) : null;
  const c = e => feed.card(db, e, user, friendsMap);
  const t = feed.trending(db, city);
  const out = { city, trending: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.map(c)])) };
  if (user) {
    out.forYou = feed.forYou(db, user, city, 12).map(p => ({ ...c(p.e), reasons: p.reasons }));
    out.friendsGoing = feed.upcoming(db, city).filter(e => friendsMap.get(e.id)?.size).sort((a, b) => friendsMap.get(b.id).size - friendsMap.get(a.id).size).slice(0, 10).map(c);
  }
  out.stats = { events: feed.upcoming(db, city).length, free: feed.upcoming(db, city).filter(e => e.priceMin === 0).length };
  return out;
});
route('GET', '/api/events', ({ user, qs }) => {
  const list = filterEvents(qs, user);
  const offset = Math.max(0, +qs.get('offset') || 0), limit = Math.min(60, +qs.get('limit') || 24);
  const friendsMap = user ? feed.friendSignals(db, user) : null;
  return { total: list.length, items: list.slice(offset, offset + limit).map(e => feed.card(db, e, user, friendsMap)) };
});
route('GET', '/api/map', ({ user, qs }) => {
  const list = filterEvents(qs, user);
  const friendsMap = user ? feed.friendSignals(db, user) : null;
  return { items: list.slice(0, 400).map(e => feed.card(db, e, user, friendsMap)) };
});
route('GET', '/api/events/:id', ({ user, params }) => { const ev = db.events[params.id] || fail(404, 'Event not found'); track(user, ev.id, 'view'); return { event: eventFull(ev, user) }; });
route('POST', '/api/events/:id/track', ({ user, params, body }) => { if (!['view', 'click'].includes(body.type)) fail(400, 'Bad type'); track(user, params.id, body.type); return { ok: true }; });
route('POST', '/api/events/:id/save', ({ user, params }) => {
  need(user); const ev = db.events[params.id] || fail(404, 'Event not found');
  const list = (db.saves[user.id] ||= []); const i = list.indexOf(ev.id);
  if (i >= 0) { list.splice(i, 1); ev.stats.saves = Math.max(0, ev.stats.saves - 1); } else { list.push(ev.id); ev.stats.saves++; track(user, ev.id, 'save'); }
  return { saved: i < 0, count: list.length };
});
route('POST', '/api/events/:id/interested', ({ user, params }) => {
  need(user); const ev = db.events[params.id] || fail(404, 'Event not found');
  const had = db.interactions.some(i => i.userId === user.id && i.eventId === ev.id && i.type === 'interested');
  if (had) db.interactions = db.interactions.filter(i => !(i.userId === user.id && i.eventId === ev.id && i.type === 'interested'));
  else track(user, ev.id, 'interested');
  return { interested: !had };
});
route('GET', '/api/saved', ({ user }) => { need(user); const fm = feed.friendSignals(db, user); return { items: (db.saves[user.id] || []).map(id => db.events[id]).filter(Boolean).sort((a, b) => a.start.localeCompare(b.start)).map(e => feed.card(db, e, user, fm)) }; });

// bookings
route('POST', '/api/bookings', ({ user, body }) => {
  need(user); sweepHolds();
  const ev = db.events[body.eventId] || fail(404, 'Event not found');
  if (new Date(ev.start) < Date.now() - 30 * 60000) fail(400, 'This event has already started');
  const items = (Array.isArray(body.items) ? body.items : []).filter(i => i && +i.qty > 0);
  if (!items.length) fail(400, 'Pick at least one ticket');
  const total = items.reduce((s, i) => s + +i.qty, 0);
  if (total > 10) fail(400, 'Maximum 10 tickets per booking');
  const lines = items.map(i => {
    const t = ev.tiers.find(t => t.id === i.tierId) || fail(400, 'Unknown ticket type');
    const qty = Math.floor(+i.qty);
    if (t.capacity - t.sold < qty) fail(409, `Only ${Math.max(0, t.capacity - t.sold)} left for ${t.name}`);
    return { tierId: t.id, name: t.name, price: t.price, qty };
  });
  // reserve inventory for HOLD_MINUTES
  for (const l of lines) { const t = ev.tiers.find(t => t.id === l.tierId); t.sold += l.qty; t.fsold = (t.fsold || 0) + l.qty; }
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const fee = Math.round(subtotal * FEE_RATE);
  const b = { id: 'bk_' + crypto.randomBytes(6).toString('hex'), userId: user.id, eventId: ev.id, items: lines, subtotal, fee, total: subtotal + fee, status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + HOLD_MINUTES * 60000).toISOString(), groupId: body.groupId || null };
  db.bookings[b.id] = b;
  return { booking: bookingView(b) };
});
function bookingView(b) { const ev = db.events[b.eventId]; return { ...b, event: ev ? feed.card(db, ev) : null, venue: ev?.venue }; }
route('GET', '/api/bookings', ({ user }) => { need(user); sweepHolds(); return { items: Object.values(db.bookings).filter(b => b.userId === user.id && b.status !== 'expired' && b.status !== 'pending').sort((a, b) => (db.events[a.eventId]?.start || '').localeCompare(db.events[b.eventId]?.start || '')).map(bookingView) }; });
route('GET', '/api/bookings/:id', ({ user, params }) => { need(user); sweepHolds(); const b = db.bookings[params.id]; if (!b || b.userId !== user.id) fail(404, 'Booking not found'); return { booking: bookingView(b) }; });
route('POST', '/api/bookings/:id/pay', ({ user, params, body }) => {
  need(user); sweepHolds();
  const b = db.bookings[params.id]; if (!b || b.userId !== user.id) fail(404, 'Booking not found');
  if (b.status === 'expired') fail(410, 'Your hold expired — tickets were released. Please start again.');
  if (b.status !== 'pending') fail(400, 'This booking is already ' + b.status);
  const a = body.attendee || {};
  if (!a.name || String(a.name).trim().length < 2) fail(400, 'Enter the attendee name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email || '')) fail(400, 'Enter a valid email for the ticket');
  if (!/^[6-9]\d{9}$/.test(String(a.phone || '').replace(/\D/g, '').slice(-10))) fail(400, 'Enter a valid 10-digit Indian mobile number');
  if (!['upi', 'card', 'netbanking', 'free'].includes(body.method)) fail(400, 'Choose a payment method');
  if (b.total > 0 && body.method === 'free') fail(400, 'Choose a payment method');
  // DEMO GATEWAY — replace with Razorpay/Stripe order + signature verification in production
  if (body.method === 'upi' && b.total > 0 && !/^[\w.\-]{2,}@[a-z]{2,}$/i.test(body.upiId || '')) fail(400, 'Enter a valid UPI ID (like name@okbank)');
  if (body.method === 'card' && !/^\d{16}$/.test(String(body.cardNumber || '').replace(/\s/g, ''))) fail(400, 'Enter a 16-digit card number');
  b.status = 'confirmed'; b.paidAt = new Date().toISOString(); b.method = body.method;
  b.paymentRef = 'pay_demo_' + crypto.randomBytes(5).toString('hex');
  b.code = 'FN-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  b.attendee = { name: String(a.name).trim().slice(0, 60), email: String(a.email).toLowerCase(), phone: String(a.phone).replace(/\D/g, '').slice(-10) };
  delete b.expiresAt;
  track(user, b.eventId, 'book');
  return { booking: bookingView(b) };
});
route('POST', '/api/bookings/:id/cancel', ({ user, params }) => {
  need(user); const b = db.bookings[params.id]; if (!b || b.userId !== user.id) fail(404, 'Booking not found');
  if (!['confirmed', 'pending'].includes(b.status)) fail(400, 'Booking cannot be cancelled');
  const ev = db.events[b.eventId];
  const hoursLeft = ev ? (new Date(ev.start) - Date.now()) / 3600000 : 0;
  if (b.status === 'confirmed' && hoursLeft < 0) fail(400, 'Event already started');
  releaseInventory(b);
  b.refund = b.status === 'confirmed' ? (hoursLeft >= 24 ? b.subtotal : Math.round(b.subtotal * 0.5)) : 0;
  b.status = 'cancelled'; b.cancelledAt = new Date().toISOString();
  return { booking: bookingView(b) };
});
route('GET', '/api/bookings/:id/ics', ({ user, params, res }) => {
  need(user); const b = db.bookings[params.id]; if (!b || b.userId !== user.id || b.status !== 'confirmed') fail(404, 'Booking not found');
  res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="funillion-${b.code}.ics"` });
  res.end(ics(b, db.events[b.eventId])); return null;
});

// AI Plan My Day
route('POST', '/api/plan', async ({ user, body }) => {
  const query = String(body.query || '').slice(0, 400);
  let c = planner.parse(query, user);
  if (!body.noLlm) c = (await planner.llmParse(query, c)) || c;
  if (body.overrides) for (const k of ['budget', 'people', 'date', 'from', 'to', 'zone', 'city', 'maxStops']) if (body.overrides[k] !== undefined && body.overrides[k] !== '') c[k] = body.overrides[k];
  if (!CITIES.some(x => x.id === c.city)) c.city = user?.city || 'delhi';
  c.people = Math.min(20, Math.max(1, +c.people || 1));
  const result = planner.optimize(db, user, c);
  result.parser = c.parser || 'funillion-nlp';
  result.dateLabel = planner.fmtDay(result.constraints.date);
  if (user) { const id = 'pl_' + crypto.randomBytes(5).toString('hex'); db.plans[id] = { id, userId: user.id, query, at: new Date().toISOString(), constraints: result.constraints }; result.id = id; }
  return result;
});

// friends
route('GET', '/api/friends', ({ user }) => {
  need(user);
  const incoming = db.friendRequests.filter(r => r.to === user.id && r.status === 'pending').map(r => auth.publicUser(db.users[r.from]));
  const outgoing = db.friendRequests.filter(r => r.from === user.id && r.status === 'pending').map(r => auth.publicUser(db.users[r.to]));
  const excluded = new Set([user.id, ...user.friends, ...outgoing.map(u => u.id), ...incoming.map(u => u.id)]);
  // suggestions: same city first, ranked by mutual friends + shared interests
  const suggestions = Object.values(db.users).filter(u => !excluded.has(u.id) && u.username !== 'demo')
    .map(u => ({ u, s: (u.city === user.city ? 2 : 0) + u.friends.filter(f => user.friends.includes(f)).length + u.interests.filter(i => user.interests.includes(i)).length * 0.5 }))
    .sort((a, b) => b.s - a.s).slice(0, 8).map(({ u }) => ({ ...auth.publicUser(u), mutual: u.friends.filter(f => user.friends.includes(f)).length, cityName: CITIES.find(c => c.id === u.city)?.short }));
  return { friends: user.friends.map(id => db.users[id]).filter(Boolean).map(u => ({ ...auth.publicUser(u), cityName: CITIES.find(c => c.id === u.city)?.short })), incoming, outgoing, suggestions };
});
route('GET', '/api/users/search', ({ user, qs }) => {
  need(user); const q = (qs.get('q') || '').toLowerCase().trim(); if (q.length < 2) return { items: [] };
  return { items: Object.values(db.users).filter(u => u.id !== user.id && (u.username.includes(q) || u.name.toLowerCase().includes(q))).slice(0, 10).map(u => ({ ...auth.publicUser(u), isFriend: user.friends.includes(u.id), cityName: CITIES.find(c => c.id === u.city)?.short })) };
});
route('POST', '/api/friends/request', ({ user, body }) => {
  need(user);
  const target = body.userId ? db.users[body.userId] : auth.findByLogin(db, body.username);
  if (!target || target.id === user.id) fail(404, 'User not found');
  if (user.friends.includes(target.id)) fail(400, 'Already friends');
  const reverse = db.friendRequests.find(r => r.from === target.id && r.to === user.id && r.status === 'pending');
  const makeFriends = () => { user.friends.push(target.id); target.friends.push(user.id); };
  if (reverse) { reverse.status = 'accepted'; makeFriends(); return { status: 'friends' }; }
  if (db.friendRequests.some(r => r.from === user.id && r.to === target.id && r.status === 'pending')) return { status: 'pending' };
  if (target.bot) { makeFriends(); return { status: 'friends', message: `${target.name.split(' ')[0]} accepted your request` }; } // demo people accept instantly
  db.friendRequests.push({ from: user.id, to: target.id, status: 'pending', at: new Date().toISOString() });
  return { status: 'pending' };
});
route('POST', '/api/friends/respond', ({ user, body }) => {
  need(user);
  const r = db.friendRequests.find(r => r.from === body.userId && r.to === user.id && r.status === 'pending') || fail(404, 'Request not found');
  r.status = body.accept ? 'accepted' : 'declined';
  if (body.accept) { const other = db.users[r.from]; if (!user.friends.includes(other.id)) user.friends.push(other.id); if (!other.friends.includes(user.id)) other.friends.push(user.id); }
  return { ok: true };
});
route('DELETE', '/api/friends/:id', ({ user, params }) => {
  need(user); const other = db.users[params.id];
  user.friends = user.friends.filter(f => f !== params.id); if (other) other.friends = other.friends.filter(f => f !== user.id);
  return { ok: true };
});

// groups
const myGroup = (user, id) => { const g = db.groups[id]; if (!g || !g.members.includes(user.id)) fail(404, 'Group not found'); return g; };
route('GET', '/api/groups', ({ user }) => {
  need(user);
  return { items: Object.values(db.groups).filter(g => g.members.includes(user.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(g => ({ id: g.id, name: g.name, city: g.city, members: g.members.map(id => auth.publicUser(db.users[id])).filter(Boolean), candidates: g.candidates.length, finalEvent: g.finalEventId && db.events[g.finalEventId] ? feed.card(db, db.events[g.finalEventId]) : null, lastMessage: g.messages.at(-1)?.text || null })) };
});
route('POST', '/api/groups', ({ user, body }) => {
  need(user);
  const name = String(body.name || '').trim().slice(0, 50) || 'New plan';
  const members = [...new Set([user.id, ...(body.memberIds || []).filter(id => user.friends.includes(id))])];
  const g = { id: 'g_' + crypto.randomBytes(5).toString('hex'), name, ownerId: user.id, members, city: body.city || user.city, inviteCode: crypto.randomBytes(4).toString('hex'), createdAt: new Date().toISOString(), candidates: [], messages: [], finalEventId: null };
  for (const eid of (body.eventIds || []).slice(0, 8)) if (db.events[eid]) g.candidates.push({ eventId: eid, addedBy: user.id, votes: [user.id], at: new Date().toISOString() });
  if (body.note) g.messages.push({ userId: user.id, text: String(body.note).slice(0, 500), at: new Date().toISOString() });
  db.groups[g.id] = g;
  for (const c of g.candidates) botsReact(g, 'candidate', c.eventId);
  return { group: groupView(g, user) };
});
route('GET', '/api/groups/:id', ({ user, params }) => { need(user); return { group: groupView(myGroup(user, params.id), user) }; });
route('POST', '/api/groups/join', ({ user, body }) => {
  need(user); const g = Object.values(db.groups).find(g => g.inviteCode === body.code) || fail(404, 'Invite link is invalid or expired');
  if (!g.members.includes(user.id)) { g.members.push(user.id); g.messages.push({ userId: user.id, text: `${user.name.split(' ')[0]} joined the plan 👋`, at: new Date().toISOString(), system: true }); }
  return { group: groupView(g, user) };
});
route('POST', '/api/groups/:id/candidates', ({ user, params, body }) => {
  need(user); const g = myGroup(user, params.id); const ev = db.events[body.eventId] || fail(404, 'Event not found');
  if (!g.candidates.some(c => c.eventId === ev.id)) { g.candidates.push({ eventId: ev.id, addedBy: user.id, votes: [user.id], at: new Date().toISOString() }); botsReact(g, 'candidate', ev.id); }
  return { group: groupView(g, user) };
});
route('POST', '/api/groups/:id/vote', ({ user, params, body }) => {
  need(user); const g = myGroup(user, params.id); const c = g.candidates.find(c => c.eventId === body.eventId) || fail(404, 'Option not found');
  c.votes = c.votes.includes(user.id) ? c.votes.filter(v => v !== user.id) : [...c.votes, user.id];
  return { group: groupView(g, user) };
});
route('POST', '/api/groups/:id/messages', ({ user, params, body }) => {
  need(user); const g = myGroup(user, params.id); const text = String(body.text || '').trim().slice(0, 500); if (!text) fail(400, 'Empty message');
  g.messages.push({ userId: user.id, text, at: new Date().toISOString() }); botsReact(g, 'message');
  return { group: groupView(g, user) };
});
route('POST', '/api/groups/:id/finalize', ({ user, params, body }) => {
  need(user); const g = myGroup(user, params.id); if (g.ownerId !== user.id) fail(403, 'Only the plan creator can lock the final pick');
  if (!g.candidates.some(c => c.eventId === body.eventId)) fail(400, 'Pick one of the options');
  g.finalEventId = body.eventId; g.messages.push({ userId: user.id, text: `🎉 Locked in: ${db.events[body.eventId].title}. Book your tickets!`, at: new Date().toISOString(), system: true });
  return { group: groupView(g, user) };
});
route('POST', '/api/groups/:id/members', ({ user, params, body }) => {
  need(user); const g = myGroup(user, params.id); if (!user.friends.includes(body.userId)) fail(400, 'You can add friends only');
  if (!g.members.includes(body.userId)) g.members.push(body.userId);
  return { group: groupView(g, user) };
});
route('POST', '/api/groups/:id/leave', ({ user, params }) => { need(user); const g = myGroup(user, params.id); g.members = g.members.filter(m => m !== user.id); if (!g.members.length) delete db.groups[g.id]; else if (g.ownerId === user.id) g.ownerId = g.members[0]; return { ok: true }; });

// organiser + aggregation
route('GET', '/api/organizer/events', ({ user }) => {
  need(user);
  const mine = Object.values(db.events).filter(e => e.organizerUserId === user.id);
  return { items: mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(e => {
    const bks = Object.values(db.bookings).filter(b => b.eventId === e.id && b.status === 'confirmed');
    return { ...feed.card(db, e), stats: e.stats, bookings: bks.length, ticketsSold: bks.reduce((s, b) => s + b.items.reduce((x, i) => x + i.qty, 0), 0), revenue: bks.reduce((s, b) => s + b.subtotal, 0), sources: e.sources.map(s => SOURCE_META[s.source]?.name) };
  }) };
});
route('POST', '/api/organizer/import', async ({ user, body }) => { need(user); try { return { draft: await importFromUrl(String(body.url || '').trim()) }; } catch (e) { fail(422, e.message || 'Could not read that page'); } });
route('POST', '/api/organizer/events', ({ user, body }) => {
  need(user);
  const title = String(body.title || '').trim(); if (title.length < 4) fail(400, 'Add a proper title');
  if (!CATEGORIES.some(c => c.id === body.category)) fail(400, 'Pick a category');
  const city = CITIES.find(c => c.id === body.city) || fail(400, 'Pick a city');
  const start = new Date(body.start); if (isNaN(start) || start < Date.now()) fail(400, 'Pick a future date & time');
  const area = city.areas.find(a => a.name === body.area) || resolveArea(city.id, body.area);
  const tiers = (Array.isArray(body.tiers) && body.tiers.length ? body.tiers : [{ name: 'Entry', price: 0, capacity: 100 }]).slice(0, 5).map(t => ({ name: String(t.name || 'Entry').slice(0, 40), price: Math.max(0, Math.round(+t.price || 0)), capacity: Math.max(1, Math.min(100000, Math.round(+t.capacity || 100))), sold: 0 }));
  const rec = { source: 'organizer', sourceId: crypto.randomBytes(6).toString('hex'), url: body.sourceUrl || null, title, category: body.category, city: city.id, area, venue: String(body.venue || area.name).slice(0, 80), lat: area.lat + (Math.random() - 0.5) * 0.004, lng: area.lng + (Math.random() - 0.5) * 0.004, start: start.toISOString(), durH: Math.max(0.5, Math.min(72, +body.durH || 2)), tiers, priceMin: Math.min(...tiers.map(t => t.price)), description: String(body.description || '').slice(0, 2000), organizer: String(body.organizer || user.name).slice(0, 60), organizerUserId: user.id, image: /^https:\/\//.test(body.image || '') ? body.image : null };
  const r = ingest(db, rec);
  if (r.action === 'merged') { r.event.organizerUserId ||= user.id; r.event.lockedTitle = title; r.event.title = title; }
  return { event: feed.card(db, r.event), action: r.action, matchedTitle: r.matchedTitle, score: r.score };
});
route('GET', '/api/aggregation', () => ({ stats: db.meta.aggregation, sources: SOURCE_META }));
route('POST', '/api/aggregation/run', ({ user }) => { need(user); return { stats: runAggregation(db) }; });

// ---------------------------------------------------------------- static
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp' };
function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': p.endsWith('.jpg') ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  res.setHeader('x-content-type-options', 'nosniff');
  const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
  if (!r) return send(res, 404, { error: 'Not found' });
  // CSRF guard: state-changing requests must come from this site (JSON + same origin)
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    let oh = null; try { oh = origin && new URL(origin).host; } catch {}
    if (origin && oh !== req.headers.host && oh !== req.headers['x-forwarded-host'] && !ALLOWED_HOSTS.has(oh)) return send(res, 403, { error: 'Cross-site request blocked' });
  }
  try {
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const user = auth.userFromRequest(db, req);
    const out = await r.handler({ req, res, user, params, body, qs: url.searchParams, ip: clientIp(req) });
    if (req.method !== 'GET' || r.re.source.includes('events\\/')) store.save(db);
    if (out !== null && !res.headersSent) send(res, 200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong' });
  }
});
server.listen(PORT, () => {
  console.log(`\n  ✳ Funillion is live → http://localhost:${PORT}`);
  console.log(`    Demo login: demo / funillion   ·   ${feed.upcoming(db).length} upcoming events across ${CITIES.length} cities\n`);
});
process.on('SIGINT', () => { store.save(db, true); process.exit(0); });
