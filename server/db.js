// Tiny JSON-file database. Single Node process = no write races; writes are atomic (tmp + rename).
const fs = require('fs');
const path = require('path');

// On Railway, mount a Volume and data survives redeploys (RAILWAY_VOLUME_MOUNT_PATH is set automatically)
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Bump when the shape of an existing collection changes in a way old data must be moved for (see migrate()).
const SCHEMA_VERSION = 2;

function empty() {
  return {
    meta: { version: SCHEMA_VERSION, createdAt: new Date().toISOString() },
    users: {}, sessions: {}, events: {}, sourceIndex: {}, saves: {}, interactions: [], bookings: {}, groups: {}, friendRequests: [],
    itineraryQueries: {}, // saved "Plan My Day" itinerary requests (was called `plans` before schema v2)
    // --- social matching + real-world plans (schema v2) ---
    availability: {},   // id -> { id, userId, type:'recurring'|'once', dayOfWeek, date, startHour, endHour, label, source, createdAt, expiresAt }
    plans: {},           // id -> Plan (see server/plans/service.js for the full shape + status machine)
    communities: {},     // id -> Community
    conversations: {},   // id -> { id, kind:'plan'|'community', refId, createdAt }
    messages: {},         // conversationId -> [{ id, userId, text, system, at }]
    blocks: [],           // [{ blockerId, blockedId, at }]
    reports: [],          // [{ id, reporterId, targetType, targetId, reason, note, at, status }]
  };
}

// Moves data whose shape changed between schema versions. Runs once per load; a fresh empty() DB
// is already on SCHEMA_VERSION and skips this. Never destructive: old data is relocated, not dropped.
function migrate(db) {
  const v = db.meta.version || 1;
  if (v < 2) {
    // v1 kept AI "Plan My Day" itinerary requests under db.plans: {id,userId,query,at,constraints}.
    // v2 repurposes db.plans for real social plans (Create-a-Plan), so move the old rows first.
    db.itineraryQueries = db.itineraryQueries || {};
    for (const [id, p] of Object.entries(db.plans || {})) {
      if (p && typeof p.query === 'string' && !db.itineraryQueries[id]) db.itineraryQueries[id] = p;
    }
    db.plans = {};
  }
  db.meta.version = SCHEMA_VERSION;
  return db;
}

function load() {
  if (!fs.existsSync(DB_FILE)) return null;
  try { return migrate(Object.assign(empty(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')))); }
  catch (e) { console.error('Could not read db.json, starting fresh:', e.message); return null; }
}

let timer = null;
function save(db, immediate = false) {
  const write = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    // keep the interaction log bounded
    if (db.interactions.length > 50000) db.interactions = db.interactions.slice(-40000);
    const json = JSON.stringify(db);
    fs.writeFileSync(tmp, json);
    try { fs.renameSync(tmp, DB_FILE); } catch { fs.writeFileSync(DB_FILE, json); try { fs.unlinkSync(tmp); } catch {} } // Windows can lock files briefly
  };
  clearTimeout(timer);
  if (immediate) return write();
  timer = setTimeout(write, 300);
}

module.exports = { load, save, empty, DB_FILE, DATA_DIR };
