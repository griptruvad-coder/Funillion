// Communities: persistent interest groups whose whole point is turning online membership into
// real-world plans — see "Create Plan for Community" (POST /plans with communityId set) and
// plansFor() (GET /communities/:id/plans).
const crypto = require('crypto');
const chat = require('../chat');
const auth = require('../auth');
const { INTEREST_IDS } = require('../interests');
const { HttpError } = require('../errors');

function badRequest(msg, status = 400) { return new HttpError(status, msg); }
function slugify(name) { return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'community'; }

function create(db, creator, { name, description, icon, interestTags, visibility }) {
  const clean = String(name || '').trim();
  if (clean.length < 3) throw badRequest('Name must be at least 3 characters');
  if (Object.values(db.communities).some(c => c.name.toLowerCase() === clean.toLowerCase())) throw badRequest('A community with that name already exists', 409);
  let slug = slugify(clean), n = 1;
  while (Object.values(db.communities).some(c => c.slug === slug)) slug = `${slugify(clean)}-${++n}`;
  const id = 'cm_' + crypto.randomBytes(6).toString('hex');
  const community = {
    id, slug, name: clean.slice(0, 60), description: String(description || '').slice(0, 300), icon: icon ? String(icon).trim().slice(0, 4) : '✳',
    interestTags: Array.isArray(interestTags) ? [...new Set(interestTags.filter(i => INTEREST_IDS.has(i)))].slice(0, 6) : [],
    visibility: visibility === 'private' ? 'private' : 'public',
    creatorId: creator.id, members: [{ userId: creator.id, role: 'creator', joinedAt: new Date().toISOString() }],
    posts: [], conversationId: null, createdAt: new Date().toISOString(),
  };
  db.communities[id] = community;
  return community;
}

function join(db, community, user) {
  if (community.members.some(m => m.userId === user.id)) return community;
  if (community.visibility === 'private') throw badRequest('This community is invite-only', 403);
  community.members.push({ userId: user.id, role: 'member', joinedAt: new Date().toISOString() });
  if (!community.conversationId) community.conversationId = chat.createConversation(db, 'community', community.id);
  chat.postMessage(db, community.conversationId, user.id, `${user.name.split(' ')[0]} joined 👋`, { system: true });
  return community;
}

function leave(db, community, userId) {
  community.members = community.members.filter(m => m.userId !== userId);
  if (community.creatorId === userId) { const next = community.members[0]; if (next) { community.creatorId = next.userId; next.role = 'creator'; } }
}

function post(db, community, user, { text, kind }) {
  const member = community.members.find(m => m.userId === user.id);
  if (!member) throw badRequest('Join the community first', 403);
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) throw badRequest('Empty post');
  const isAnnouncement = kind === 'announcement' && ['creator', 'moderator'].includes(member.role);
  const p = { id: 'cp_' + crypto.randomBytes(6).toString('hex'), authorId: user.id, kind: isAnnouncement ? 'announcement' : 'post', text: clean, createdAt: new Date().toISOString() };
  community.posts.push(p);
  return p;
}

function setModerator(db, community, byUserId, targetUserId, isModerator) {
  if (community.creatorId !== byUserId) throw badRequest('Only the creator can set moderators', 403);
  const m = community.members.find(x => x.userId === targetUserId);
  if (!m) throw badRequest('Not a member', 404);
  if (m.role !== 'creator') m.role = isModerator ? 'moderator' : 'member';
}

function view(db, community, viewerId) {
  const me = community.members.find(m => m.userId === viewerId);
  return {
    id: community.id, slug: community.slug, name: community.name, description: community.description, icon: community.icon,
    interestTags: community.interestTags, visibility: community.visibility, creatorId: community.creatorId,
    memberCount: community.members.length, isMember: !!me, myRole: me?.role || null,
    members: community.members.slice(0, 60).map(m => ({ ...auth.publicUser(db.users[m.userId]), role: m.role, joinedAt: m.joinedAt })),
    posts: community.posts.slice(-40).reverse().map(p => ({ ...p, author: auth.publicUser(db.users[p.authorId]) })),
    createdAt: community.createdAt,
  };
}

function list(db, viewer) {
  return Object.values(db.communities)
    .filter(c => c.visibility === 'public' || (viewer && c.members.some(m => m.userId === viewer.id)))
    .sort((a, b) => b.members.length - a.members.length);
}

function plansFor(db, communityId) {
  return Object.values(db.plans).filter(p => p.communityId === communityId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// A handful of real starter communities so the app isn't empty on day one (demo mode only —
// same idea as the existing demo events/people, never seeded in production).
function seedStarterCommunities(db, creatorUser) {
  if (!creatorUser) return;
  const starters = [
    ['AI & ML', 'Building, learning and arguing about AI/ML — meetups and hackathons welcome.', '◆', ['ai-ml', 'hackathons', 'coding']],
    ['Startups', 'Founders, early employees and the startup-curious.', '⚡', ['startups', 'networking']],
    ['Coding', 'Study groups, pair programming, dev meetups.', '⌨', ['coding', 'hackathons', 'ai-ml']],
    ['Football', 'Weekend five-a-side and watch parties.', '⚽', ['football', 'sports']],
    ['Badminton', 'Find a doubles partner or split a court.', '🏸', ['badminton', 'sports']],
    ['Photography', 'Photowalks and gear talk.', '◉', ['photography', 'arts']],
    ['Gaming', 'Game nights and esports watch-alongs.', '✦', ['gaming']],
  ];
  for (const [name, description, icon, interestTags] of starters) {
    if (Object.values(db.communities).some(c => c.name === name)) continue;
    create(db, creatorUser, { name, description, icon, interestTags, visibility: 'public' });
  }
}

module.exports = { create, join, leave, post, setModerator, view, list, plansFor, seedStarterCommunities, slugify };
