// Availability windows: recurring weekly slots ("free most weekday evenings") or one-off slots
// ("free tonight 6-9pm"). "I'm Free" taps create short-lived one-off rows (source:'im_free',
// ttlHours set) so a quick tap doesn't leave a stale "always free" row behind.
const crypto = require('crypto');
const { dowOfKey } = require('../util');
const { HttpError } = require('../errors');

function badRequest(msg) { return new HttpError(400, msg); }

function add(db, userId, { type, dayOfWeek, date, startHour, endHour, label, source = 'manual', ttlHours } = {}) {
  if (!['recurring', 'once'].includes(type)) throw badRequest('type must be "recurring" or "once"');
  const s = Number(startHour), e = Number(endHour);
  if (!(s >= 0 && s < 30) || !(e > s && e <= 30)) throw badRequest('Invalid time window');
  if (type === 'recurring' && !(Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6)) throw badRequest('dayOfWeek 0-6 required for recurring availability');
  if (type === 'once' && !/^\d{4}-\d\d-\d\d$/.test(date || '')) throw badRequest('date (YYYY-MM-DD) required for a one-off window');
  const row = {
    id: 'av_' + crypto.randomBytes(6).toString('hex'), userId,
    type, dayOfWeek: type === 'recurring' ? dayOfWeek : null, date: type === 'once' ? date : null,
    startHour: s, endHour: e, label: label ? String(label).slice(0, 60) : null, source,
    createdAt: new Date().toISOString(), expiresAt: ttlHours ? new Date(Date.now() + ttlHours * 3600000).toISOString() : null,
  };
  db.availability[row.id] = row;
  return row;
}

function remove(db, userId, id) {
  const row = db.availability[id];
  if (row && row.userId === userId) delete db.availability[id];
}

// Drops expired one-off/im-free rows. Cheap enough to call at the top of any read.
function sweep(db) {
  const now = Date.now();
  for (const [id, row] of Object.entries(db.availability)) if (row.expiresAt && new Date(row.expiresAt).getTime() < now) delete db.availability[id];
}

function listFor(db, userId) {
  sweep(db);
  return Object.values(db.availability).filter(a => a.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Does `userId` have a stated window overlapping [dateKey, fromHour, toHour)?
// null = they've never stated any availability (unknown, not a hard "no" — callers should treat
// this neutrally rather than excluding the person outright).
function overlaps(db, userId, dateKey, fromHour, toHour) {
  const rows = listFor(db, userId);
  if (!rows.length) return null;
  const dow = dowOfKey(dateKey);
  return rows.some(a => {
    if (a.type === 'once' && a.date !== dateKey) return false;
    if (a.type === 'recurring' && a.dayOfWeek !== dow) return false;
    return a.startHour < toHour && a.endHour > fromHour;
  });
}

module.exports = { add, remove, sweep, listFor, overlaps };
