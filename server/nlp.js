// Shared natural-language parsing helpers (date/time/budget/headcount/radius extraction).
// Extracted out of server/planner.js so the new social plan-intent parser
// (server/plans/intent.js) reuses the exact same date/budget/people logic instead of a
// second, slightly-different copy. Pure functions only — no event/plan knowledge here.
const { istDayKey, addDaysKey, dowOfKey } = require('./util');

const DAY_WORDS = [
  [0, ['sunday', 'sun', 'ravivar', 'itvaar', 'itwar', 'raviwar']], [1, ['monday', 'mon', 'somvar', 'somwar']], [2, ['tuesday', 'tue', 'tues', 'mangalvar', 'mangalwar']],
  [3, ['wednesday', 'wed', 'budhvar', 'budhwar']], [4, ['thursday', 'thu', 'thurs', 'guruvar', 'guruwar', 'veervar']], [5, ['friday', 'fri', 'shukravar', 'shukrawar']],
  [6, ['saturday', 'sat', 'shanivar', 'shaniwar']],
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const TIME_WORDS = [
  [['morning', 'subah', 'savere', 'breakfast'], 7, 12], [['afternoon', 'dopahar', 'lunch'], 12, 17],
  [['evening', 'shaam', 'sham', 'sundown', 'sunset'], 17, 23], [['night', 'raat', 'tonight', 'late night', 'midnight'], 19, 26],
  [['full day', 'pura din', 'whole day', 'all day', 'din bhar'], 9, 24],
];

const normalize = query => ' ' + String(query || '').toLowerCase().replace(/[’']/g, '') + ' ';
const hasWord = (q, w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(q);

// today/tomorrow/day-after/weekend/named weekday/"12 Jan" -> { date: 'YYYY-MM-DD', namedDay }. null if nothing found.
function parseDateKey(q, has, todayKey = istDayKey(new Date())) {
  const todayDow = dowOfKey(todayKey);
  if (/\b(today|aaj|tonight|abhi)\b/.test(q)) return { date: todayKey, namedDay: false };
  if (/\b(tomorrow|kal|tmrw|tmr)\b/.test(q)) return { date: addDaysKey(todayKey, 1), namedDay: false };
  if (/day after tomorrow|parso/.test(q)) return { date: addDaysKey(todayKey, 2), namedDay: false };
  if (/weekend/.test(q)) return { date: todayDow === 6 || todayDow === 0 ? todayKey : addDaysKey(todayKey, 6 - todayDow), namedDay: false };
  for (const [dow, words] of DAY_WORDS) if (words.some(has)) return { date: addDaysKey(todayKey, (dow - todayDow + 7) % 7), namedDay: true };
  const m = q.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (m) {
    const y = +todayKey.slice(0, 4), mo = MONTHS.indexOf(m[2]) + 1;
    let key = `${y}-${String(mo).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
    if (key < todayKey) key = `${y + 1}${key.slice(4)}`;
    return { date: key, namedDay: false };
  }
  return null;
}

// time-of-day word ("evening") gives a baseline window; an explicit "after 6pm" / "before 9"
// then refines it (both can combine, e.g. "evening after 8pm") -> { from, to } as IST hours (0-26).
function parseTimeWindow(q, has) {
  let from = null, to = null;
  for (const [words, f, t] of TIME_WORDS) if (words.some(has)) { from = f; to = t; break; }
  let m = q.match(/(?:after|baad|from|se)\s*(\d{1,2})(?::(\d\d))?\s*(am|pm|baje)?/) || q.match(/(\d{1,2})(?::(\d\d))?\s*(am|pm|baje)\s*(?:ke baad|onwards|se)/);
  if (m) { let h = +m[1]; if ((m[3] === 'pm' || (m[3] === 'baje' && h < 11)) && h < 12) h += 12; from = h + (+m[2] || 0) / 60; to = to && to > from ? to : 26; }
  m = q.match(/(?:before|till|until|tak)\s*(\d{1,2})\s*(am|pm|baje)?/);
  if (m) { let h = +m[1]; if ((m[2] === 'pm' || m[2] === 'baje') && h < 12) h += 12; if (m[2] === 'am' && h < 6) h += 24; to = h; if (from == null) from = 9; }
  if (from == null) { from = 9; to = 26; }
  return { from, to };
}

// "₹1500" / "rs 800" / "1.5k" / "under 500" / bare "5000" / "free" -> whole-group rupees, or null.
function parseBudget(q) {
  let v = null;
  let m = q.match(/(?:₹|rs\.?|inr|budget|under|below|within|max|upto|up to|andar)\s*([\d,.]+)\s*(k)?/) || q.match(/([\d,.]+)\s*(k)?\s*(?:₹|rs|rupees|rupaye|rupay|budget|inr)/);
  if (m) { let x = parseFloat(m[1].replace(/,/g, '')); if (m[2]) x *= 1000; if (x >= 0 && x < 1e6) v = Math.round(x); }
  if (v == null) {
    for (const mm of q.matchAll(/(\d[\d,.]*)(k?)\s*([a-z]*)/g)) {
      if (['am', 'pm', 'baje', 'log', 'people', 'ppl', 'friends', 'km', 'min', 'mins', 'st', 'nd', 'rd', 'th'].includes(mm[3]) || MONTHS.includes(mm[3])) continue;
      const x = parseFloat(mm[1].replace(/,/g, '')) * (mm[2] ? 1000 : 1);
      if (x >= 100) { v = Math.round(x); break; }
    }
  }
  if (v == null && /\bfree\b|muft|free mein|no money/.test(q)) v = 0;
  return v;
}

// "3 friends" / "4 people" / "group of 5" -> headcount, or null (caller decides the default).
function parsePeopleCount(q) {
  let m = q.match(/(\d+)\s*(?:friends|dost|doston|buddies)/); if (m) return +m[1] + 1;
  m = q.match(/(\d+)\s*(?:people|log|logo|ppl|persons|of us|members|jan)/); if (m) return +m[1];
  m = q.match(/(?:group of|squad of|team of)\s*(\d+)/); if (m) return +m[1];
  return null;
}
const isSolo = q => /\b(solo|alone|akela|akeli|myself)\b/.test(q);

// "within 5km" / "5 km radius" / "nearby" -> kilometres, or null.
function parseRadiusKm(q) {
  const m = q.match(/(?:within|under|inside)?\s*(\d+(?:\.\d+)?)\s*km/); if (m) return Math.min(50, Math.max(0.5, +m[1]));
  if (/\bnearby\b|\bclose by\b|\bwalking distance\b|paas\s*mein/.test(q)) return 2;
  return null;
}

// 18.5 -> "18:30"; wraps hours past midnight (26 -> "02:00") the same way the rest of the app treats late-night IST hours.
function hourToHHMM(h) {
  const hh = Math.floor(h) % 24, mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Cleans a budget value from a request body: null/undefined/'' (unspecified) stays null,
// a real 0 stays 0 (meaningfully different — "must be free" vs "no limit given").
// Plain `+v || null`-style fallbacks get this wrong because `+null === 0`.
function cleanBudget(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = +v;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

module.exports = { DAY_WORDS, MONTHS, TIME_WORDS, normalize, hasWord, parseDateKey, parseTimeWindow, parseBudget, parsePeopleCount, isSolo, parseRadiusKm, hourToHHMM, cleanBudget };
