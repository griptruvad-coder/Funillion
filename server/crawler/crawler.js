// Funillion crawler — polite, incremental, structured-data only.
//  • obeys robots.txt (incl. Crawl-delay) and identifies itself
//  • one request at a time per website, 1.5 s+ apart; stops a site on repeated blocks
//  • reads schema.org Event JSON-LD (what sites publish for search engines); stores facts + a link back
//  • remembers what it has seen, so each run only fetches new or stale pages
const zlib = require('zlib');
const robotsLib = require('./robots');
const { extractEvents, toRecord, eventLinks } = require('./extract');
const { activeSites } = require('./sites');
const { hackToRecord } = require('./hackathons');

const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES_PER_SITE) || 120;
const MIN_DELAY = Number(process.env.CRAWL_DELAY_MS) || 1500;
const UA = `Mozilla/5.0 (compatible; FunillionBot/1.0; +${process.env.BOT_INFO_URL || 'https://funillion.com/bot'}${process.env.CONTACT_EMAIL ? '; ' + process.env.CONTACT_EMAIL : ''})`;
const GENERIC_EVENT_PATH = /\/(e|event|events)\/[^/]{6,}/i;
const DAY = 86400000;

const hosts = new Map(); // host → { robots, delay, next }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rawFetch(url, { maxBytes = 6_000_000, accept = 'text/html,application/xhtml+xml' } = {}) {
  const controller = new AbortController(); const t = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': UA, accept, 'accept-language': 'en-IN,en;q=0.9' } });
    let buf = Buffer.alloc(0);
    if (res.body) {
      const reader = res.body.getReader(); const chunks = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; chunks.push(value); if (size > maxBytes) { controller.abort(); break; } }
      buf = Buffer.concat(chunks);
    }
    if (/\.gz($|\?)/.test(url) || (buf[0] === 0x1f && buf[1] === 0x8b)) { try { buf = zlib.gunzipSync(buf); } catch {} }
    return { status: res.status, text: buf.toString('utf8'), url: res.url || url };
  } catch (e) { return { status: 0, text: '', url, error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(t); }
}

async function hostState(origin) {
  if (hosts.has(origin) && Date.now() - hosts.get(origin).loadedAt < DAY) return hosts.get(origin);
  const r = await rawFetch(origin + '/robots.txt', { accept: 'text/plain', maxBytes: 500_000 });
  // RFC 9309: 4xx = no rules (allowed); 5xx / unreachable = assume disallowed
  const robots = r.status >= 200 && r.status < 300 ? robotsLib.parse(r.text) : r.status >= 400 && r.status < 500 ? { rules: [], delay: null, sitemaps: [] } : { rules: [{ allow: false, path: '/' }], delay: null, sitemaps: [], unreachable: true };
  const st = { robots, delay: Math.max(MIN_DELAY, (robots.delay || 0) * 1000), next: 0, loadedAt: Date.now() };
  hosts.set(origin, st);
  return st;
}

// polite GET: robots check + per-host spacing
async function politeGet(url, opts) {
  let origin; try { origin = new URL(url).origin; } catch { return { status: -1, blocked: 'bad url' }; }
  const h = await hostState(origin);
  if (h.robots.unreachable) return { status: -1, blocked: 'robots.txt unreachable' };
  if (!robotsLib.allowed(h.robots, url)) return { status: -1, blocked: 'robots.txt' };
  const wait = h.next - Date.now(); if (wait > 0) await sleep(wait);
  h.next = Date.now() + h.delay;
  return rawFetch(url, opts);
}

// sitemap discovery for sites that publish event sitemaps (newest first)
async function sitemapUrls(site, st, limit) {
  const h = await hostState(new URL(site.seeds[0].url).origin);
  const roots = [...(site.sitemaps || []), ...h.robots.sitemaps].slice(0, 5);
  const found = [];
  const locs = xml => [...xml.matchAll(/<(sitemap|url)>([\s\S]*?)<\/\1>/gi)].map(m => ({ kind: m[1].toLowerCase(), loc: (m[2].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1], lastmod: (m[2].match(/<lastmod>\s*([^<\s]+)/i) || [])[1] || '' })).filter(x => x.loc);
  for (const root of roots) {
    const r = await politeGet(root, { accept: 'application/xml,text/xml', maxBytes: 40_000_000 }); st.sitemaps++;
    if (r.status !== 200) continue;
    let entries = locs(r.text);
    const children = entries.filter(e => e.kind === 'sitemap' && (!site.sitemapFilter || site.sitemapFilter.test(e.loc))).sort((a, b) => b.lastmod.localeCompare(a.lastmod)).slice(0, 3);
    for (const c of children) { const cr = await politeGet(c.loc, { accept: 'application/xml,text/xml', maxBytes: 40_000_000 }); st.sitemaps++; if (cr.status === 200) entries = entries.concat(locs(cr.text)); }
    const since = new Date(Date.now() - 60 * DAY).toISOString();
    for (const e of entries) if (e.kind === 'url' && (!e.lastmod || e.lastmod >= since)) { try { const u = new URL(e.loc); if (site.eventPattern.test(u.pathname) || GENERIC_EVENT_PATH.test(u.pathname)) found.push(e); } catch {} }
  }
  return found.sort((a, b) => b.lastmod.localeCompare(a.lastmod)).slice(0, limit).map(e => e.loc);
}

// sites with a public JSON listing (hackathon platforms): a few paged requests instead of hundreds of pages
async function crawlApiSite(site, db, ingest) {
  const st = { site: site.id, name: site.name, kind: 'api', startedAt: new Date().toISOString(), pages: 0, sitemaps: 0, eventsFound: 0, created: 0, merged: 0, updated: 0, skipped: {}, blockedByRobots: 0, httpErrors: 0, errors: [], online: 0 };
  let fails = 0;
  const get = async (url, { json = false } = {}) => {
    if (fails >= 3) return null;
    const r = await politeGet(url, { accept: json ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml', maxBytes: 15_000_000 });
    if (r.blocked) { if (r.blocked === 'robots.txt') st.blockedByRobots++; else st.errors.push(r.blocked); return null; }
    st.pages++;
    if (r.status !== 200) { st.httpErrors++; fails++; if (st.errors.length < 8) st.errors.push(`${r.status || r.error} ${url.replace(/\?.*/, '')}`); return null; }
    fails = 0;
    if (!json) return r;
    try { return JSON.parse(r.text); } catch { st.errors.push(`not JSON: ${url.replace(/\?.*/, '')}`); return null; }
  };
  const helpers = { skip: why => { st.skipped[why] = (st.skipped[why] || 0) + 1; }, error: m => st.errors.push(m) };
  let hacks = [];
  try { hacks = await site.fetch(get, helpers); } catch (e) { st.errors.push(e.message); }
  for (const h of hacks) {
    st.eventsFound++;
    const r = hackToRecord(h, site);
    if (r.skip) { helpers.skip(r.skip); continue; }
    if (r.record.online) st.online++;
    const res = ingest(db, r.record);
    st[res.action] = (st[res.action] || 0) + 1;
  }
  if (fails >= 3) st.errors.push('Stopped: the site keeps refusing requests (blocked or rate-limited)');
  st.finishedAt = new Date().toISOString();
  return st;
}

async function crawlSite(site, db, ingest) {
  if (site.kind === 'api') return crawlApiSite(site, db, ingest);
  const st = { site: site.id, name: site.name, startedAt: new Date().toISOString(), pages: 0, sitemaps: 0, eventsFound: 0, created: 0, merged: 0, updated: 0, skipped: {}, blockedByRobots: 0, httpErrors: 0, errors: [] };
  db.crawl ||= { sites: {}, seen: {} };
  const seen = db.crawl.seen;
  const detail = new Set();
  let consecutiveFail = 0;
  const handleEvents = (events, pageUrl) => {
    for (const ev of events) {
      st.eventsFound++;
      const r = toRecord(ev, pageUrl, site);
      if (r.skip) { st.skipped[r.skip] = (st.skipped[r.skip] || 0) + 1; continue; }
      if (new Date(r.record.start).getTime() + r.record.durH * 3600000 < Date.now()) { st.skipped.past = (st.skipped.past || 0) + 1; continue; }
      const res = ingest(db, r.record);
      st[res.action] = (st[res.action] || 0) + 1;
    }
  };
  const visit = async url => {
    const r = await politeGet(url);
    if (r.blocked) { if (r.blocked === 'robots.txt') st.blockedByRobots++; else st.errors.push(`${r.blocked}`); return null; }
    st.pages++;
    if (r.status !== 200) {
      st.httpErrors++; consecutiveFail++;
      if (st.errors.length < 8) st.errors.push(`${r.status || r.error} ${url}`);
      return null;
    }
    consecutiveFail = 0;
    return r;
  };

  // 1) listing pages per city (+ sitemaps where configured)
  for (const seed of site.seeds) {
    if (st.pages >= MAX_PAGES || consecutiveFail >= 4) break;
    const r = await visit(seed.url);
    if (!r) continue;
    const { events, urls } = extractEvents(r.text);
    handleEvents(events, r.url);
    const hostOk = u => { try { const h = new URL(u).hostname; return h === new URL(r.url).hostname || (site.hostPattern && site.hostPattern.test(h)); } catch { return false; } };
    for (const u of [...urls.filter(hostOk), ...eventLinks(r.text, r.url, site.eventPattern), ...eventLinks(r.text, r.url, GENERIC_EVENT_PATH)]) detail.add(u);
    if (site.hostPattern) for (const m of r.text.matchAll(/href=["'](https:\/\/[a-z0-9-]+\.devfolio\.co\/?)["']/gi)) detail.add(m[1]);
  }
  if (site.sitemapFilter && consecutiveFail < 4) { try { for (const u of await sitemapUrls(site, st, MAX_PAGES)) detail.add(u); } catch (e) { st.errors.push('sitemap: ' + e.message); } }

  // 2) event detail pages — new ones first, then refresh stale upcoming ones
  const now = Date.now();
  const fresh = u => { const s = seen[u]; return s && now - s.t < (s.ev ? 3 : 14) * DAY; };
  const queue = [...detail].filter(u => !fresh(u)).sort((a, b) => (seen[a] ? 1 : 0) - (seen[b] ? 1 : 0));
  for (const url of queue) {
    if (st.pages >= MAX_PAGES) break;
    if (consecutiveFail >= 4) { st.errors.push('Stopped: the site keeps refusing requests (blocked or rate-limited)'); break; }
    const r = await visit(url);
    if (!r) continue;
    const { events } = extractEvents(r.text);
    seen[url] = { t: Date.now(), ev: events.length > 0 };
    handleEvents(events, r.url);
  }
  st.finishedAt = new Date().toISOString();
  st.detailQueued = queue.length;
  return st;
}

let running = false;
async function run(db, ingest, { only, log = console.log } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  db.crawl ||= { sites: {}, seen: {} };
  const sites = activeSites().filter(s => !only || only.includes(s.id));
  const t0 = Date.now();
  try {
    // different websites in parallel, each website strictly sequential & polite
    const results = await Promise.all(sites.map(s => crawlSite(s, db, ingest).catch(e => ({ site: s.id, name: s.name, errors: [e.message] }))));
    for (const r of results) db.crawl.sites[r.site] = r;
    // forget pages not seen for 45 days
    for (const [u, s] of Object.entries(db.crawl.seen)) if (Date.now() - s.t > 45 * DAY) delete db.crawl.seen[u];
    db.crawl.lastRun = new Date().toISOString();
    const tot = results.reduce((a, r) => ({ pages: a.pages + (r.pages || 0), created: a.created + (r.created || 0), merged: a.merged + (r.merged || 0) }), { pages: 0, created: 0, merged: 0 });
    log(`› Crawler: ${sites.length} sites · ${tot.pages} pages · ${tot.created} new events · ${tot.merged} merged · ${Math.round((Date.now() - t0) / 1000)} s`);
    return { sites: results, ...tot };
  } finally { running = false; }
}

module.exports = { run, isRunning: () => running, UA };
