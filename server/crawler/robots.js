// Minimal robots.txt parser (RFC 9309): groups per user-agent, Allow/Disallow with * and $, longest match wins.
const UA_TOKEN = 'funillionbot';

function parse(text) {
  const groups = []; let cur = null; let lastWasAgent = false;
  const sitemaps = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(), val = line.slice(i + 1).trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') { if (val || key === 'allow') cur.rules.push({ allow: key === 'allow', path: val }); }
    else if (key === 'crawl-delay') { const d = parseFloat(val); if (d >= 0) cur.delay = d; }
  }
  // pick our group, else the * group
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && UA_TOKEN.includes(a)));
  const star = groups.filter(g => g.agents.includes('*'));
  const use = mine.length ? mine : star;
  const rules = use.flatMap(g => g.rules), delay = use.map(g => g.delay).find(d => d != null) ?? null;
  return { rules, delay, sitemaps };
}

function toRegex(path) {
  let re = '^' + path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  if (re.endsWith('\\$')) re = re.slice(0, -2) + '$';
  return new RegExp(re);
}

function allowed(robots, url) {
  if (!robots) return true;
  let p; try { const u = new URL(url); p = u.pathname + u.search; } catch { return false; }
  let best = null;
  for (const r of robots.rules) {
    if (r.path === '') continue;
    if (toRegex(r.path).test(p)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

module.exports = { parse, allowed, UA_TOKEN };
