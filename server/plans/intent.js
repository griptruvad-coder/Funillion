// AI "Create a Plan": free text -> structured intent JSON.
//   1. Deterministic keyword/regex parse (works offline, in English + Hinglish).
//   2. Optional Claude refinement (only with ANTHROPIC_API_KEY) — but its output is validated,
//      type-checked and clamped field-by-field before use. It only ever returns plain JSON; it
//      never sees the database and never decides who gets matched or invited (server/plans/service.js
//      does that with the deterministic compatibility engine).
const { istDayKey, istHour } = require('../util');
const nlp = require('../nlp');
const { INTEREST_IDS, INTERESTS } = require('../interests');

// Finer-grained than the event CATEGORIES so "badminton" and "football" aren't both just "sports".
const ACTIVITY_WORDS = {
  badminton: ['badminton'],
  football: ['football', 'soccer'],
  sports: ['sports', 'run', 'running', 'cricket', 'cycling', 'fitness', 'pickleball', 'trek', 'workout'],
  'ai-ml': ['ai', 'ml', 'machine learning', 'artificial intelligence', 'deep learning', 'nlp', 'llm'],
  startups: ['startup', 'startups', 'founder', 'founders', 'investor', 'pitch', 'entrepreneur'],
  coding: ['coding', 'programming', 'developer', 'dev meetup', 'open source'],
  hackathons: ['hackathon', 'hack', 'build event'],
  photography: ['photography', 'photowalk', 'photo walk', 'photoshoot'],
  gaming: ['gaming', 'game night', 'esports', 'valorant', 'bgmi', 'fifa', 'chess'],
  food: ['cafe', 'café', 'coffee', 'brunch', 'dinner', 'lunch', 'khana', 'biryani'],
  meetups: ['meetup', 'meet people', 'new people', 'hangout', 'board game', 'book club'],
  networking: ['networking', 'professionals', 'career'],
  workshops: ['workshop', 'masterclass'],
  music: ['music', 'concert', 'gig', 'jam session'],
  wellness: ['yoga', 'meditation', 'wellness', 'run club'],
  arts: ['art', 'museum', 'gallery'],
  comedy: ['comedy', 'standup', 'open mic'],
  parties: ['party', 'clubbing'],
};
// Sensible headcount defaults when the text doesn't say a number (badminton doubles = 4, etc).
const DEFAULT_PARTICIPANTS = { badminton: 4, football: 10, sports: 4, food: 3, meetups: 4, networking: 4, startups: 4, hackathons: 4, coding: 3, 'ai-ml': 4, photography: 3, gaming: 4, workshops: 4, music: 3, wellness: 3, arts: 3, comedy: 4, parties: 5 };

function parseIntent(text, user) {
  const q = nlp.normalize(text);
  const has = w => nlp.hasWord(q, w);
  const today = istDayKey(new Date());

  let activity = null; const interests = [];
  for (const [id, words] of Object.entries(ACTIVITY_WORDS)) if (words.some(has)) { if (!activity) activity = id; interests.push(id); }

  const dateInfo = nlp.parseDateKey(q, has, today);
  const date = dateInfo ? dateInfo.date : today;
  let { from, to } = nlp.parseTimeWindow(q, has);
  // nlp.parseTimeWindow's fallback (9am-2am) is meant for "search the whole day" in the itinerary
  // planner — useless as an actual proposed meeting time, so give plans a narrower, sensible default.
  if (from === 9 && to === 26) {
    if (date === today) { from = Math.min(22, istHour(new Date()) + 1); to = Math.min(26, from + 3); }
    else { from = 18; to = 21; }
  }
  const budget = nlp.parseBudget(q);
  const explicitPeople = nlp.parsePeopleCount(q);
  const radius_km = nlp.parseRadiusKm(q) ?? 5;
  const participants_needed = explicitPeople || DEFAULT_PARTICIPANTS[activity] || 3;

  return {
    raw: text, activity, interests: [...new Set(interests)],
    date, time_range: [nlp.hourToHHMM(from), nlp.hourToHHMM(to)],
    budget, participants_needed, radius_km,
    city: user?.city || 'delhi', parser: 'funillion-nlp',
  };
}

// Only runs with ANTHROPIC_API_KEY; any failure at all falls back to the heuristic result untouched.
async function llmParseIntent(text, base) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const sys = `Convert a request to do a real-world activity with other people into JSON. Today (IST) is ${istDayKey(new Date())}. Valid activity/interest ids: ${INTERESTS.map(i => i.id).join(', ')}. Respond with ONLY JSON: {"activity": string|null (one valid id, or a short free-text label if truly nothing fits), "date": "YYYY-MM-DD"|null, "time_range": ["HH:MM","HH:MM"]|null, "budget": number|null (rupees per person), "participants_needed": number|null, "radius_km": number|null, "interests": string[] (subset of the valid ids)}`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.FUNILLION_MODEL || 'claude-sonnet-5', max_tokens: 300, system: sys, messages: [{ role: 'user', content: text }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data.content?.map(b => b.text || '').join('') || '';
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));

    // Validate + clamp every field individually — nothing from the model reaches the database
    // (or anything else) without passing through these checks first.
    const out = { ...base, parser: 'claude' };
    if (typeof j.activity === 'string' && j.activity.trim()) out.activity = INTEREST_IDS.has(j.activity) ? j.activity : (base.activity || j.activity.trim().slice(0, 30));
    if (/^\d{4}-\d\d-\d\d$/.test(j.date || '')) out.date = j.date;
    if (Array.isArray(j.time_range) && j.time_range.length === 2 && j.time_range.every(t => /^\d{1,2}:\d{2}$/.test(t))) out.time_range = j.time_range;
    if (Number.isFinite(j.budget) && j.budget >= 0 && j.budget < 1e6) out.budget = Math.round(j.budget);
    if (Number.isFinite(j.participants_needed) && j.participants_needed > 0) out.participants_needed = Math.min(30, Math.max(2, Math.round(j.participants_needed)));
    if (Number.isFinite(j.radius_km) && j.radius_km > 0) out.radius_km = Math.min(50, Math.max(0.5, j.radius_km));
    if (Array.isArray(j.interests)) out.interests = [...new Set(j.interests.filter(x => INTEREST_IDS.has(x)))];
    return out;
  } catch { return null; } finally { clearTimeout(timer); }
}

module.exports = { parseIntent, llmParseIntent, ACTIVITY_WORDS, DEFAULT_PARTICIPANTS };
