const crypto = require('crypto');
const { CITIES, CATEGORIES } = require('./catalog');

// stay logged in for 90 days; every visit after a week pushes it forward again (rolling), so active users never get logged out
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 90;
const RENEW_AFTER_MS = 7 * 86400000;
const cityIds = new Set(CITIES.map(c => c.id));
const catIds = new Set(CATEGORIES.map(c => c.id));

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}

function validateSignup({ name, username, email, password, city }) {
  if (!name || String(name).trim().length < 2) return 'Please enter your name';
  if (!/^[a-z0-9_.]{3,20}$/i.test(username || '')) return 'Username: 3–20 letters, numbers, _ or .';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return 'Enter a valid email';
  if (!password || password.length < 6) return 'Password must be at least 6 characters';
  if (!cityIds.has(city)) return 'Pick your city';
  return null;
}

function createUser(db, { name, username, email, password, city, interests = [], bot = false }) {
  const { salt, hash } = hashPassword(password);
  const user = {
    id: 'u_' + crypto.randomBytes(6).toString('hex'), name: String(name).trim().slice(0, 60), username: username.toLowerCase(), email: email.toLowerCase(),
    salt, hash, city, interests: interests.filter(i => catIds.has(i)), friends: [], bot, createdAt: new Date().toISOString(),
    avatarHue: Math.floor(Math.random() * 360),
  };
  db.users[user.id] = user;
  return user;
}

function findByLogin(db, login) {
  const l = String(login || '').toLowerCase().trim();
  return Object.values(db.users).find(u => u.username === l || u.email === l);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[token] = { userId, exp: Date.now() + SESSION_DAYS * 86400000 };
  return token;
}

function userFromRequest(db, req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)fn_session=([^;]+)/);
  if (!m) return null;
  const s = db.sessions[m[1]];
  if (!s || s.exp < Date.now()) { if (s) delete db.sessions[m[1]]; return null; }
  const u = db.users[s.userId] || null;
  if (u && s.exp - Date.now() < SESSION_DAYS * 86400000 - RENEW_AFTER_MS) { s.exp = Date.now() + SESSION_DAYS * 86400000; req.renewedSession = m[1]; }
  return u;
}

// Secure cookies in production (HTTPS). Locally over http://localhost they must stay non-Secure.
const SECURE = process.env.COOKIE_SECURE === '1' || !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
const sessionCookie = (token, maxAgeSec) => `fn_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE ? '; Secure' : ''}`;

function publicUser(u, viewer) {
  if (!u) return null;
  const base = { id: u.id, name: u.name, username: u.username, city: u.city, avatarHue: u.avatarHue, initials: u.name.split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase() };
  if (viewer && viewer.id === u.id) return { ...base, email: u.email, interests: u.interests, friends: u.friends.length };
  return base;
}

module.exports = { hashPassword, verifyPassword, validateSignup, createUser, findByLogin, createSession, userFromRequest, sessionCookie, publicUser, SESSION_DAYS };
