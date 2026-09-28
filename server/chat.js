// One small conversation/message log shared by Plan group chat and Community group chat —
// mirrors the {userId,text,at,system} shape server.js already uses for event-group messages.
const crypto = require('crypto');

function createConversation(db, kind, refId) {
  const id = 'cv_' + crypto.randomBytes(6).toString('hex');
  db.conversations[id] = { id, kind, refId, createdAt: new Date().toISOString() };
  db.messages[id] = [];
  return id;
}

function postMessage(db, conversationId, userId, text, { system = false } = {}) {
  if (!db.conversations[conversationId]) return null;
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) return null;
  const msg = { id: 'msg_' + crypto.randomBytes(6).toString('hex'), userId, text: clean, system: !!system, at: new Date().toISOString() };
  (db.messages[conversationId] ||= []).push(msg);
  return msg;
}

function listMessages(db, conversationId, limit = 80) {
  return (db.messages[conversationId] || []).slice(-limit);
}

module.exports = { createConversation, postMessage, listMessages };
