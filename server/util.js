const crypto = require('crypto');

// Deterministic PRNG so seeds are reproducible
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const weightedPick = (rng, entries) => { // entries: [[item, weight]]
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [item, w] of entries) { if ((r -= w) <= 0) return item; }
  return entries[entries.length - 1][0];
};

const id = (prefix = '') => prefix + crypto.randomBytes(6).toString('base64url');

function haversineKm(a, b) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const STOP = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'and', '&', 'night', 'live', 'with', 'for', 'on', 'x', '-', ':', 'presents', 'edition', '2026']);
function tokens(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t));
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
// character trigram similarity – robust to small spelling differences
function trigramSim(a, b) {
  const grams = s => { s = ` ${String(s).toLowerCase().replace(/[^a-z0-9]/g, '')} `; const g = new Set(); for (let i = 0; i < s.length - 2; i++) g.add(s.slice(i, i + 3)); return g; };
  const A = grams(a), B = grams(b); let inter = 0; for (const g of A) if (B.has(g)) inter++;
  return A.size + B.size ? (2 * inter) / (A.size + B.size) : 0;
}

// IST helpers (all event times are stored as ISO strings with +05:30 offset)
const IST_OFFSET_MIN = 330;
function istDateParts(date = new Date()) {
  const d = new Date(date.getTime() + IST_OFFSET_MIN * 60000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes() };
}
const pad = n => String(n).padStart(2, '0');
function istISO(y, m, d, h = 0, min = 0) {
  // build a Date for a wall-clock time in IST
  const utc = Date.UTC(y, m - 1, d, h, min) - IST_OFFSET_MIN * 60000;
  return new Date(utc).toISOString();
}
function istDayKey(dateLike) { const p = istDateParts(new Date(dateLike)); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
function addDaysKey(key, n) { const [y, m, d] = key.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function dowOfKey(key) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function istHour(dateLike) { const p = istDateParts(new Date(dateLike)); return p.h + p.min / 60; }

module.exports = { mulberry32, pick, weightedPick, id, haversineKm, tokens, jaccard, trigramSim, istDateParts, istISO, istDayKey, addDaysKey, dowOfKey, istHour, pad };
