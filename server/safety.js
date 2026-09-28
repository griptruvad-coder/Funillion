// Block / report. Deliberately small: a symmetric block list + a flat report log.
// Every matching/discovery/plan/community listing must filter through isBlocked().
const crypto = require('crypto');

function isBlocked(db, aId, bId) {
  return db.blocks.some(b => (b.blockerId === aId && b.blockedId === bId) || (b.blockerId === bId && b.blockedId === aId));
}
function blockUser(db, blockerId, blockedId) {
  if (blockerId === blockedId || isBlocked(db, blockerId, blockedId)) return;
  db.blocks.push({ blockerId, blockedId, at: new Date().toISOString() });
}
function unblockUser(db, blockerId, blockedId) {
  db.blocks = db.blocks.filter(b => !(b.blockerId === blockerId && b.blockedId === blockedId));
}
function blockedIds(db, userId) {
  return new Set(db.blocks.filter(b => b.blockerId === userId).map(b => b.blockedId));
}
const REASONS = new Set(['spam', 'harassment', 'fake_profile', 'inappropriate_content', 'no_show', 'safety_concern', 'other']);
function reportUser(db, { reporterId, targetType, targetId, reason, note }) {
  const r = { id: 'rp_' + crypto.randomBytes(6).toString('hex'), reporterId, targetType, targetId,
    reason: REASONS.has(reason) ? reason : 'other', note: String(note || '').slice(0, 500), at: new Date().toISOString(), status: 'open' };
  db.reports.push(r);
  return r;
}

module.exports = { isBlocked, blockUser, unblockUser, blockedIds, reportUser, REASONS };
