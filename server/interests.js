// Interest taxonomy for profiles, plans and communities.
// Reuses the existing event CATEGORIES (already picked at signup, already scored by feed.js)
// as the base, plus a few finer-grained tags the event catalog doesn't distinguish
// (e.g. "sports" doesn't separate football from badminton, but communities need to).
const { CATEGORIES } = require('./catalog');

const EXTRA_INTERESTS = [
  { id: 'ai-ml', label: 'AI & ML', icon: '◆' },
  { id: 'startups', label: 'Startups', icon: '⚡' },
  { id: 'coding', label: 'Coding', icon: '⌨' },
  { id: 'football', label: 'Football', icon: '⚽' },
  { id: 'badminton', label: 'Badminton', icon: '🏸' },
  { id: 'photography', label: 'Photography', icon: '◉' },
];

const INTERESTS = [...CATEGORIES.map(c => ({ id: c.id, label: c.label, icon: c.icon })), ...EXTRA_INTERESTS];
const INTEREST_IDS = new Set(INTERESTS.map(i => i.id));
const INTEREST_LABEL = Object.fromEntries(INTERESTS.map(i => [i.id, i.label]));

// The EXTRA_INTERESTS above are finer-grained slices of an existing broader category (e.g.
// "startups" out of "networking", "badminton"/"football" out of "sports"). Someone who only
// stated the broader interest should still count as into the narrower activity.
const RELATED_INTERESTS = {
  startups: ['networking'], badminton: ['sports'], football: ['sports'],
  'ai-ml': ['hackathons', 'coding'], coding: ['hackathons'], photography: ['arts'],
};

module.exports = { INTERESTS, INTEREST_IDS, INTEREST_LABEL, RELATED_INTERESTS };
