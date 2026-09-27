// Tiny JSON-file database. Single Node process = no write races; writes are atomic (tmp + rename).
const fs = require('fs');
const path = require('path');

// On Railway, mount a Volume and data survives redeploys (RAILWAY_VOLUME_MOUNT_PATH is set automatically)
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function empty() {
  return { meta: { version: 1, createdAt: new Date().toISOString() }, users: {}, sessions: {}, events: {}, sourceIndex: {}, saves: {}, interactions: [], bookings: {}, groups: {}, friendRequests: [], plans: {} };
}

function load() {
  if (!fs.existsSync(DB_FILE)) return null;
  try { return Object.assign(empty(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); }
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
