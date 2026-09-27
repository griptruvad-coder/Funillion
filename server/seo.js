// Server-rendered, crawlable pages for search engines & link previews.
//   /in/:city                              city hub
//   /in/:city/:collection                  today | tomorrow | this-weekend | this-week | free
//   /in/:city/:category[/:collection]      e.g. /in/delhi/comedy-shows/this-weekend
//   /e/:slug-:id                           event page (schema.org Event JSON-LD)
//   /sitemap.xml, /sitemaps/*.xml, /robots.txt
// The interactive app stays at "/" (hash routes); these pages link into it for booking/saving/planning.
const { CITIES, CATEGORIES } = require('./catalog');
const { istDayKey, addDaysKey, dowOfKey } = require('./util');

const CAT_SLUG = { music: 'concerts-live-music', comedy: 'comedy-shows', hackathons: 'hackathons', bhajan: 'bhajan-clubbing', parties: 'parties-nightlife', meetups: 'meetups', workshops: 'workshops', openmic: 'open-mic-poetry', theatre: 'theatre-plays', food: 'food-drink-events', arts: 'art-culture-events', sports: 'sports-fitness', festivals: 'festivals-melas', networking: 'startup-networking-events', gaming: 'gaming-esports', wellness: 'yoga-wellness', screenings: 'movie-screenings' };
const SLUG_CAT = Object.fromEntries(Object.entries(CAT_SLUG).map(([k, v]) => [v, k]));
const COLLECTIONS = { today: 'Today', tomorrow: 'Tomorrow', 'this-weekend': 'This Weekend', 'this-week': 'This Week', free: 'Free' };
const PER_PAGE = 60;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
const eventPath = ev => {
  const cityName = CITIES.find(c => c.id === ev.city)?.short || '';
  const withCity = new RegExp(`\\b${cityName}\\b`, 'i').test(ev.title) ? ev.title : `${ev.title} ${cityName}`;
  return `/e/${slugify(withCity)}-${ev.id}`;
};
// online hackathons live under a virtual "city" so they get their own pages: /in/online, /in/online/hackathons
const ONLINE = { id: 'online', name: 'Online', short: 'Online', state: null, areas: [] };
const cityOf = id => (id === 'online' ? ONLINE : CITIES.find(c => c.id === id));
const ALL_PLACES = [...CITIES, ONLINE];
const catOf = id => CATEGORIES.find(c => c.id === id);
const TZ = { timeZone: 'Asia/Kolkata' };
const fmtDay = d => new Date(d).toLocaleDateString('en-IN', { ...TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = d => new Date(d).toLocaleDateString('en-IN', { ...TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = d => new Date(d).toLocaleTimeString('en-IN', { ...TZ, hour: 'numeric', minute: '2-digit' });
const monthYear = () => new Date().toLocaleDateString('en-IN', { ...TZ, month: 'long', year: 'numeric' });
const money = n => (n == null ? null : n === 0 ? 'Free' : '₹' + Number(n).toLocaleString('en-IN'));
const jsonLd = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const first = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).find(s => s.startsWith('https://'));
  if (first) return first.replace(/\/$/, '');
  return `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function inCollection(e, key) {
  const today = istDayKey(new Date()), day = istDayKey(e.start);
  if (key === 'today') return day === today || (e.durH >= 20 && new Date(e.start) < Date.now());
  if (key === 'tomorrow') return day === addDaysKey(today, 1);
  if (key === 'this-week') return day <= addDaysKey(today, 7);
  if (key === 'free') return e.priceMin === 0;
  if (key === 'this-weekend') { const dow = dowOfKey(today); const sat = dow === 6 ? today : dow === 0 ? addDaysKey(today, -1) : addDaysKey(today, 6 - dow); return day === sat || day === addDaysKey(sat, 1); }
  return true;
}

function page({ title, description, canonical, body, schema = [], noindex = false, ogType = 'website' }) {
  return `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">${noindex ? '<meta name="robots" content="noindex,follow">' : ''}
<meta property="og:type" content="${ogType}"><meta property="og:site_name" content="Funillion"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}"><meta name="twitter:card" content="summary">
<meta name="theme-color" content="#e4ff54">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23e4ff54'/%3E%3Ctext x='15' y='48' font-family='Arial' font-weight='900' font-size='46'%3Ef%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Space+Grotesk:wght@500;600;700&display=swap">
<link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/seo.css">
${schema.map(jsonLd).join('')}</head><body>
<header class="site-header"><a class="logo" href="/">funillion<span>✳</span></a><nav class="top-nav seo-nav"><a class="nav" href="/in/delhi">Delhi</a><a class="nav" href="/in/mumbai">Mumbai</a><a class="nav" href="/in/bengaluru">Bengaluru</a><a class="nav" href="/in/hyderabad">Hyderabad</a><a class="nav" href="/in/pune">Pune</a></nav><a class="btn primary small" style="margin-left:auto" href="/">Open Funillion ↗</a></header>
<main class="seo">${body}</main>
<footer class="seo-footer"><div><a class="logo" href="/">funillion<span>✳</span></a><p>A million ways to have fun — concerts, comedy, hackathons, bhajan clubbing, parties and meetups across India.</p></div>
<div><b>Cities</b>${CITIES.map(c => `<a href="/in/${c.id}">Events in ${esc(c.short)}</a>`).join('')}</div>
<div><b>Popular</b>${['comedy', 'music', 'hackathons', 'bhajan', 'parties', 'workshops'].map(k => `<a href="/in/delhi/${CAT_SLUG[k]}">${esc(catOf(k).label)} in Delhi</a>`).join('')}${['comedy', 'music'].map(k => `<a href="/in/mumbai/${CAT_SLUG[k]}">${esc(catOf(k).label)} in Mumbai</a>`).join('')}<a href="/in/bengaluru/hackathons">Hackathons in Bengaluru</a><a href="/in/online/hackathons">Online hackathons</a></div></footer>
</body></html>`;
}

function card(e, base) {
  const c = catOf(e.category) || { label: e.category, icon: '✳', color: '#eee', ink: '#111' };
  const d = new Date(e.start);
  const src = e.ticketing === 'external' ? ((e.links || []).find(l => l.type === 'tickets') || (e.links || [])[0])?.source : null;
  return `<li class="s-card"><a href="${eventPath(e)}">
    <span class="s-date" style="--pc:${c.color};--pi:${c.ink}"><small>${esc(d.toLocaleDateString('en-IN', { ...TZ, month: 'short' }).toUpperCase())}</small><b>${esc(d.toLocaleDateString('en-IN', { ...TZ, day: 'numeric' }))}</b></span>
    <span class="s-main"><em>${c.icon} ${esc(c.label)}</em><strong>${esc(e.title)}</strong><span>${esc(fmtDay(e.start))}${e.allDay ? '' : ' · ' + esc(fmtTime(e.start))} · ${esc(e.venue)}${e.area && !String(e.venue).includes(String(e.area).split(',')[0]) ? ', ' + esc(e.area) : ''}</span></span>
    <span class="s-price">${esc(money(e.priceMin) || 'See listing')}${src ? `<small>on ${esc(src)}</small>` : ''}</span></a></li>`;
}

function listPage(db, req, { city, cat, coll, pageNo }) {
  const base = baseUrl(req);
  const now = Date.now();
  let list = Object.values(db.events).filter(e => e.status === 'live' && e.city === city.id && new Date(e.end || e.start).getTime() > now && (!cat || e.category === cat.id) && (!coll || inCollection(e, coll)));
  list.sort((a, b) => a.start.localeCompare(b.start));
  const total = list.length;
  list = list.slice((pageNo - 1) * PER_PAGE, pageNo * PER_PAGE);
  const what = cat ? catOf(cat.id).label : 'Events';
  const when = coll ? COLLECTIONS[coll] : 'Upcoming';
  const online = city.id === 'online';
  const where = online ? 'online' : `in ${city.name}`;
  const h1 = online ? `${coll === 'free' ? 'Free online' : 'Online'} ${what.toLowerCase()}${coll && coll !== 'free' ? ' ' + when.toLowerCase() : ''}` : coll === 'free' ? `Free ${what.toLowerCase()} in ${city.name}` : coll ? `${what} in ${city.name} ${when.toLowerCase()}` : `${what} in ${city.name}`;
  const pathNow = `/in/${city.id}${cat ? '/' + CAT_SLUG[cat.id] : ''}${coll ? '/' + coll : ''}`;
  const canonical = base + pathNow + (pageNo > 1 ? `?page=${pageNo}` : '');
  const title = `${h1} — ${total ? `${total} upcoming, ` : ''}${monthYear()} | Funillion`;
  const sources = [...new Set(list.flatMap(e => e.sources.map(s => s.site || (s.source === 'google' ? null : null)).filter(Boolean)))].slice(0, 5);
  const description = total ? `${total} ${what.toLowerCase()} ${where}${coll ? ' ' + when.toLowerCase() : ''} — ${online ? 'dates, prizes, registration deadlines and links' : 'dates, venues, prices and booking links'} in one place${sources.length ? `, from ${sources.join(', ')} & more` : ''}. Plan with friends on Funillion.` : `Find ${what.toLowerCase()} ${where} on Funillion — new events are added every few hours.`;
  const cats = CATEGORIES.map(k => ({ k, n: Object.values(db.events).filter(e => e.city === city.id && e.category === k.id && new Date(e.end || e.start).getTime() > now).length })).filter(x => x.n).sort((a, b) => b.n - a.n);
  const crumbs = [{ name: 'Funillion', url: base + '/' }, { name: city.name, url: `${base}/in/${city.id}` }, ...(cat ? [{ name: what, url: `${base}/in/${city.id}/${CAT_SLUG[cat.id]}` }] : []), ...(coll ? [{ name: when, url: base + pathNow }] : [])];
  const body = `
  <nav class="crumbs">${crumbs.map((c, i) => i < crumbs.length - 1 ? `<a href="${esc(c.url.replace(base, '') || '/')}">${esc(c.name)}</a> / ` : `<span>${esc(c.name)}</span>`).join('')}</nav>
  <p class="eyebrow">${esc(city.name.toUpperCase())} · ${esc(monthYear().toUpperCase())}</p>
  <h1>${esc(h1)}</h1>
  <p class="lede">${total ? `${total} ${esc(what.toLowerCase())} coming up${coll ? ' ' + esc(when.toLowerCase()) : ''} ${esc(where)} — with dates, ${online ? 'prizes, registration deadlines' : 'venues, prices'} and where to ${online ? 'register' : 'book'}. Funillion checks ${online ? 'Devfolio, Unstop, Devpost, HackerEarth and more' : 'ticketing sites and organisers'} every few hours, so this list stays fresh.` : `No ${esc(what.toLowerCase())} listed${coll ? ' ' + esc(when.toLowerCase()) : ''} ${esc(where)} right now. New events are added every few hours — check the full list below.`}</p>
  <div class="chips wrap s-chips">${Object.entries(COLLECTIONS).map(([k, v]) => `<a class="chip ${coll === k ? 'selected' : ''}" href="/in/${city.id}${cat ? '/' + CAT_SLUG[cat.id] : ''}/${k}">${esc(v)}</a>`).join('')}${coll ? `<a class="chip" href="/in/${city.id}${cat ? '/' + CAT_SLUG[cat.id] : ''}">All dates</a>` : ''}</div>
  ${list.length ? `<ol class="s-list">${list.map(e => card(e, base)).join('')}</ol>` : `<div class="empty"><h3>Nothing here yet</h3><p><a class="link" href="/in/${city.id}">See everything in ${esc(city.short)}</a></p></div>`}
  ${total > pageNo * PER_PAGE ? `<p class="center"><a class="btn ghost" href="${pathNow}?page=${pageNo + 1}">More ${esc(what.toLowerCase())} →</a></p>` : ''}
  <section class="s-cta"><div><b>Plan it with friends</b><span>Save events, get a personal feed, let AI plan your day, and book in seconds.</span></div><a class="btn primary" href="/#/discover">Open Funillion ↗</a></section>
  ${cats.length ? `<section class="s-links"><h2>More in ${esc(city.short)}</h2><div class="chips wrap">${cats.map(x => `<a class="chip" href="/in/${city.id}/${CAT_SLUG[x.k.id]}">${x.k.icon} ${esc(x.k.label)} <small>(${x.n})</small></a>`).join('')}</div></section>` : ''}
  ${cat ? `<section class="s-links"><h2>${esc(what)} ${online ? 'in cities' : 'in other cities'}</h2><div class="chips wrap">${(cat.id === 'hackathons' ? ALL_PLACES : CITIES).filter(c => c.id !== city.id).map(c => `<a class="chip" href="/in/${c.id}/${CAT_SLUG[cat.id]}">${c.id === 'online' ? '🌐 Online' : esc(c.short)}</a>`).join('')}</div></section>` : ''}`;
  const schema = [
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })) },
    ...(list.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', name: h1, numberOfItems: total, itemListElement: list.slice(0, 30).map((e, i) => ({ '@type': 'ListItem', position: i + 1, url: base + eventPath(e) })) }] : []),
  ];
  // thin pages (0–1 events) stay out of Google's index but keep links followable
  return page({ title, description, canonical, body, schema, noindex: total < 2 || pageNo > 1 });
}

function eventPage(db, req, ev) {
  const base = baseUrl(req);
  const city = cityOf(ev.city), c = catOf(ev.category) || { label: ev.category, icon: '✳' };
  const ended = new Date(ev.end || ev.start).getTime() < Date.now();
  const canonical = base + eventPath(ev);
  const links = ev.ticketing === 'external' ? (ev.links || []) : [];
  const tickets = links.filter(l => l.type === 'tickets');
  const price = money(ev.priceMin);
  const when = `${fmtLong(ev.start)}${ev.allDay ? '' : ', ' + fmtTime(ev.start)}`;
  const online = !!ev.online;
  const title = online ? `${ev.title} — online hackathon, ${fmtDay(ev.start)} | Register & details | Funillion` : `${ev.title} — ${fmtDay(ev.start)}, ${ev.venue}, ${city.short} | Tickets & details | Funillion`;
  const description = `${ev.title} ${online ? 'online' : `at ${ev.venue}, ${city.name}`} on ${when}.${price ? ` ${online ? 'Entry' : 'Tickets'} ${price === 'Free' ? 'free' : 'from ' + price}.` : ''} ${String(ev.description || '').slice(0, 110)}`.trim();
  const similar = Object.values(db.events).filter(e => e.id !== ev.id && e.city === ev.city && e.category === ev.category && new Date(e.end || e.start) > Date.now()).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 6);
  const body = `
  <nav class="crumbs"><a href="/">Funillion</a> / <a href="/in/${city.id}">${esc(city.name)}</a> / <a href="/in/${city.id}/${CAT_SLUG[ev.category]}">${esc(c.label)}</a> / <span>${esc(ev.title)}</span></nav>
  <article class="s-event">
    <p class="eyebrow">${c.icon} ${esc(c.label.toUpperCase())} · ${esc(city.name.toUpperCase())}</p>
    <h1>${esc(ev.title)}</h1>
    ${ended ? '<p class="note">This event has ended. <a class="link" href="/in/' + city.id + '/' + CAT_SLUG[ev.category] + '">See upcoming ' + esc(c.label.toLowerCase()) + ' in ' + esc(city.short) + ' →</a></p>' : ''}
    <dl class="s-facts">
      <div><dt>When</dt><dd>${esc(when)}${ev.allDay ? ' <small>(timing on the listing)</small>' : ''}</dd></div>
      <div><dt>Where</dt><dd>${online ? '🌐 Online — join from anywhere' : esc(ev.venue)}${online ? '' : ev.address ? `<small>${esc(ev.address)}</small>` : ev.area ? `<small>${esc(ev.area)}, ${esc(city.name)}</small>` : ''}</dd></div>
      ${ev.hack?.deadline ? `<div><dt>Register by</dt><dd>${esc(fmtLong(ev.hack.deadline))}</dd></div>` : ''}
      ${ev.hack?.prize ? `<div><dt>Prizes</dt><dd>${esc(ev.hack.prize)}</dd></div>` : ''}
      <div><dt>Price</dt><dd>${esc(price || 'On the listing')}</dd></div>
      ${ev.organizer ? `<div><dt>Organiser</dt><dd>${esc(ev.organizer)}</dd></div>` : ''}
    </dl>
    ${ev.description ? `<p class="prose">${esc(ev.description)}</p>` : ''}
    <div class="s-actions">
      ${!ended && ev.ticketing !== 'external' ? `<a class="btn primary big" href="/#/event/${ev.id}">Get tickets on Funillion</a>` : ''}
      ${!ended ? (tickets.length ? tickets : links).slice(0, 4).map((l, i) => `<a class="btn ${i ? 'ghost' : 'primary'} big" rel="nofollow sponsored noopener" target="_blank" href="${esc(l.url)}">${l.type === 'tickets' ? (ev.category === 'hackathons' ? 'Register on' : 'Book on') : 'Details on'} ${esc(l.source || 'listing')} ↗</a>`).join('') : ''}
      <a class="btn dark big" href="/#/event/${ev.id}">☺ Save · plan with friends</a>
      ${online ? '' : `<a class="btn ghost big" target="_blank" rel="noopener" href="${esc(ev.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${ev.venue} ${ev.address || city.name}`)}`)}">⌖ Directions</a>`}
    </div>
    ${ev.sources.length > 1 ? `<p class="fine">Listed on ${ev.sources.length} platforms — Funillion merged them into one page.</p>` : ''}
  </article>
  ${similar.length ? `<section class="s-links"><h2>More ${esc(c.label.toLowerCase())} in ${esc(city.short)}</h2><ol class="s-list">${similar.map(e => card(e, base)).join('')}</ol></section>` : ''}
  <section class="s-cta"><div><b>Going with friends?</b><span>Make a group plan, vote on options and let AI plan the rest of your day.</span></div><a class="btn primary" href="/#/event/${ev.id}">Open in Funillion ↗</a></section>`;
  const schemaEvent = {
    '@context': 'https://schema.org', '@type': 'Event', name: ev.title, url: canonical,
    startDate: ev.allDay ? istDayKey(ev.start) : new Date(ev.start).toLocaleString('sv-SE', TZ).replace(' ', 'T') + '+05:30',
    ...(ev.end && !ev.allDay ? { endDate: new Date(ev.end).toLocaleString('sv-SE', TZ).replace(' ', 'T') + '+05:30' } : {}),
    eventStatus: 'https://schema.org/EventScheduled', eventAttendanceMode: `https://schema.org/${online ? 'Online' : 'Offline'}EventAttendanceMode`,
    location: online ? { '@type': 'VirtualLocation', url: tickets[0]?.url || canonical } : { '@type': 'Place', name: ev.venue, address: { '@type': 'PostalAddress', streetAddress: ev.address || ev.venue, addressLocality: ev.area || city.short, addressRegion: city.state, addressCountry: 'IN' }, ...(!ev.approxLocation && ev.lat ? { geo: { '@type': 'GeoCoordinates', latitude: ev.lat, longitude: ev.lng } } : {}) },
    ...(ev.description ? { description: ev.description } : {}),
    ...(ev.organizer ? { organizer: { '@type': 'Organization', name: ev.organizer } } : {}),
    ...(ev.priceMin != null ? { offers: { '@type': 'Offer', price: ev.priceMin, priceCurrency: 'INR', url: tickets[0]?.url || canonical, availability: 'https://schema.org/InStock' } } : {}),
  };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ name: 'Funillion', item: base + '/' }, { name: city.name, item: `${base}/in/${city.id}` }, { name: c.label, item: `${base}/in/${city.id}/${CAT_SLUG[ev.category]}` }, { name: ev.title, item: canonical }].map((x, i) => ({ '@type': 'ListItem', position: i + 1, ...x })) };
  return page({ title, description, canonical, body, schema: ended ? [crumbs] : [schemaEvent, crumbs], noindex: ended, ogType: 'article' });
}

// ---------- sitemaps
const xml = (urls) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('')}</urlset>`;
function sitemapIndex(db, req) {
  const base = baseUrl(req), today = new Date().toISOString().slice(0, 10);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${base}/sitemaps/pages.xml</loc><lastmod>${today}</lastmod></sitemap>${ALL_PLACES.map(c => `<sitemap><loc>${base}/sitemaps/events-${c.id}.xml</loc><lastmod>${today}</lastmod></sitemap>`).join('')}</sitemapindex>`;
}
function sitemapPages(db, req) {
  const base = baseUrl(req), now = Date.now(), today = new Date().toISOString().slice(0, 10);
  const up = Object.values(db.events).filter(e => e.status === 'live' && new Date(e.end || e.start).getTime() > now);
  const urls = [{ loc: base + '/', lastmod: today }];
  for (const city of ALL_PLACES) {
    const ce = up.filter(e => e.city === city.id);
    if (ce.length >= 2) urls.push({ loc: `${base}/in/${city.id}`, lastmod: today });
    for (const k of Object.keys(COLLECTIONS)) if (ce.filter(e => inCollection(e, k)).length >= 2) urls.push({ loc: `${base}/in/${city.id}/${k}`, lastmod: today });
    for (const cat of CATEGORIES) { const n = ce.filter(e => e.category === cat.id); if (n.length >= 2) urls.push({ loc: `${base}/in/${city.id}/${CAT_SLUG[cat.id]}`, lastmod: today }); if (n.filter(e => inCollection(e, 'this-weekend')).length >= 2) urls.push({ loc: `${base}/in/${city.id}/${CAT_SLUG[cat.id]}/this-weekend`, lastmod: today }); }
  }
  return xml(urls);
}
function sitemapEvents(db, req, cityId) {
  const base = baseUrl(req), now = Date.now();
  return xml(Object.values(db.events).filter(e => e.city === cityId && e.status === 'live' && new Date(e.end || e.start).getTime() > now).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 45000).map(e => ({ loc: base + eventPath(e), lastmod: (e.updatedAt || e.createdAt || '').slice(0, 10) })));
}

// returns true if it handled the request
function handle(db, req, res, url) {
  const send = (status, body, type = 'text/html; charset=utf-8', cache = 'public, max-age=600') => { res.writeHead(status, { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' }); res.end(body); return true; };
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (p === '/robots.txt') return send(200, `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`, 'text/plain; charset=utf-8');
  if (p === '/sitemap.xml') return send(200, sitemapIndex(db, req), 'application/xml; charset=utf-8');
  if (p === '/sitemaps/pages.xml') return send(200, sitemapPages(db, req), 'application/xml; charset=utf-8');
  let m = p.match(/^\/sitemaps\/events-([a-z]+)\.xml$/);
  if (m && cityOf(m[1])) return send(200, sitemapEvents(db, req, m[1]), 'application/xml; charset=utf-8');
  m = p.match(/^\/e\/(?:[a-z0-9-]*-)?(ev_[a-z0-9]+)$/i);
  if (m) {
    const ev = db.events[m[1]];
    if (!ev) return send(404, page({ title: 'Event not found | Funillion', description: 'This event is no longer listed.', canonical: baseUrl(req) + p, body: '<div class="empty"><h3>This event is no longer listed</h3><p><a class="link" href="/">Find something fun →</a></p></div>', noindex: true }));
    if (p !== eventPath(ev)) { res.writeHead(301, { location: eventPath(ev) }); res.end(); return true; } // title changed → keep one canonical URL
    return send(200, eventPage(db, req, ev));
  }
  m = p.match(/^\/in\/([a-z]+)(?:\/([a-z0-9-]+))?(?:\/([a-z0-9-]+))?$/);
  if (m) {
    const city = cityOf(m[1]);
    if (!city) return send(404, page({ title: 'City not found | Funillion', description: 'Funillion covers 14 Indian cities.', canonical: baseUrl(req) + p, body: `<div class="empty"><h3>We're not in that city yet</h3><p>${CITIES.map(c => `<a class="link" href="/in/${c.id}">${esc(c.short)}</a>`).join(' · ')}</p></div>`, noindex: true }));
    let cat = null, coll = null;
    if (m[2]) { if (SLUG_CAT[m[2]]) cat = catOf(SLUG_CAT[m[2]]); else if (COLLECTIONS[m[2]]) coll = m[2]; else return send(404, page({ title: 'Page not found | Funillion', description: '', canonical: baseUrl(req) + p, body: `<div class="empty"><h3>Page not found</h3><p><a class="link" href="/in/${city.id}">Events in ${esc(city.short)} →</a></p></div>`, noindex: true })); }
    if (m[3]) { if (cat && COLLECTIONS[m[3]]) coll = m[3]; else return send(404, page({ title: 'Page not found | Funillion', description: '', canonical: baseUrl(req) + p, body: `<div class="empty"><h3>Page not found</h3><p><a class="link" href="/in/${city.id}">Events in ${esc(city.short)} →</a></p></div>`, noindex: true })); }
    const pageNo = Math.max(1, Math.min(50, parseInt(url.searchParams.get('page') || '1', 10) || 1));
    return send(200, listPage(db, req, { city, cat, coll, pageNo }));
  }
  return false;
}

module.exports = { handle, eventPath, CAT_SLUG };
