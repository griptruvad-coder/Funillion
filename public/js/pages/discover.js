import { state, api, $, $$, esc, city, cat, avatar, money, rail, card, go, loading, errorBox, debounce } from '../core.js';
import { openCityPicker } from '../app.js';

const f = { q: '', cat: 'all', when: 'all', price: 'all', mode: '', sort: 'recommended' };
let lastCity = null;

// ---------- small teaser cards for the new social sections (Plans / People / Communities) ----------
const fmtWhen = iso => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
function planTeaser(p) {
  return `<a class="suggest-card" href="#/plans/${p.id}" style="scroll-snap-align:start">
    <div class="suggest-top"><h3>${esc(p.title)}</h3></div>
    <div class="suggest-meta"><span>🕐 ${fmtWhen(p.startTime)}</span>${p.distanceLabel ? `<span>⌖ ${esc(p.distanceLabel)}</span>` : ''}</div>
    ${p.reasons?.length ? `<div class="reasons">${p.reasons.map(r => `<span>${esc(r)}</span>`).join('')}</div>` : ''}
    <div class="avatars"><span>${p.interestedCount}/${p.maxParticipants} going</span></div>
  </a>`;
}
function personTeaser(r) {
  const pct = Math.round(r.compatibility_score * 100);
  return `<a class="suggest-card" href="#/plans" style="scroll-snap-align:start;align-items:flex-start">
    <div class="suggest-top">${avatar(r.user)}<span class="compat" style="--s:${pct}">${pct}%</span></div>
    <b style="font:600 15.5px var(--head)">${esc(r.user.name)}</b>
    ${r.reasons?.length ? `<div class="reasons">${r.reasons.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
  </a>`;
}
function communityTeaser(c) {
  return `<a class="community-card" href="#/communities/${c.id}" style="scroll-snap-align:start">
    <div class="community-head"><span class="community-icon">${esc(c.icon || '✳')}</span><b style="font:600 16px var(--head)">${esc(c.name)}</b></div>
    <p class="small muted">${c.memberCount} member${c.memberCount === 1 ? '' : 's'}${c.reasons?.[0] ? ' · ' + esc(c.reasons[0]) : ''}</p>
  </a>`;
}

export async function render(el, _, params) {
  if (!state.city) { el.innerHTML = `<div class="empty"><h3>Pick a city to start</h3><p>Funillion is live across India.</p><button class="btn primary" id="pick">Choose city</button></div>`; $('#pick').onclick = openCityPicker; openCityPicker(); return; }
  if (lastCity !== state.city) { Object.assign(f, { q: '', cat: 'all', when: 'all', price: 'all', mode: '' }); lastCity = state.city; }
  if (params.get('mode')) f.mode = params.get('mode');
  if (params.get('cat')) f.cat = params.get('cat');
  if (params.get('q') !== null) f.q = params.get('q') || '';
  if (params.get('when')) f.when = params.get('when');
  const c = city(state.city);
  const first = state.user ? state.user.name.split(' ')[0] : null;
  el.innerHTML = `
    <section class="home-cta">
      <p class="eyebrow">✦ TELL US WHAT YOU WANT TO DO</p>
      <h2>${first ? `${esc(first)}, w` : 'W'}hat do you want to do today?</h2>
      <form id="home-compose" class="compose-input"><input id="home-q" placeholder="e.g. Need 3 people for a café meetup under ₹500" autocomplete="off"><button class="btn primary">Find people ✦</button></form>
      <div class="home-cta-row"><a class="btn im-free-btn" href="#/create">I'm Free</a><span class="muted small" style="color:#c5c9bb">Funillion finds compatible people nearby and turns it into a real plan.</span></div>
    </section>
    <section class="disc-hero">
      <p class="eyebrow">GOOD PEOPLE. GREAT PLANS. ${esc(c.short.toUpperCase())}.</p>
      <div class="title-line"><h1>${first ? `${esc(first)}, what's the plan <em>in ${esc(c.short)}?</em>` : `What's the plan <em>in ${esc(c.short)}?</em>`}</h1><span class="edition">${c.count} EVENTS<br>NEXT 3 WEEKS</span></div>
      <form class="searchbar" id="searchbar">
        <label class="search"><span>⌕</span><input id="q" value="${esc(f.q)}" placeholder="Artists, events, venues or a neighbourhood…" aria-label="Search events"></label>
        <select id="when" aria-label="Date"><option value="all">Any date</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="weekend">This weekend</option><option value="week">Next 7 days</option></select>
        <select id="price" aria-label="Price"><option value="all">Any price</option><option value="free">Free</option><option value="500">Under ₹500</option><option value="1000">Under ₹1,000</option><option value="2000">Under ₹2,000</option></select>
        <select id="mode" aria-label="In person or online"><option value="">In person + online</option><option value="offline">In person</option><option value="online">🌐 Online</option></select>
        <button class="btn primary">Find my fun ↗</button>
      </form>
      <div class="chips" role="group" aria-label="Categories">
        <button class="chip ${f.cat === 'all' ? 'selected' : ''}" data-cat="all">✳ All</button>
        ${state.meta.categories.map(k => `<button class="chip ${f.cat === k.id ? 'selected' : ''}" data-cat="${k.id}">${k.icon} ${esc(k.label)}</button>`).join('')}
      </div>
    </section>
    <div id="shelves"></div>
    <section class="section" id="listing">
      <div class="section-head"><div><p class="eyebrow" id="list-eyebrow">GO OUT. FIND YOUR PEOPLE.</p><h2 id="list-title">All events in ${esc(c.short)} <span id="count"></span></h2></div>
        <select id="sort" aria-label="Sort"><option value="recommended">${state.user ? 'Recommended for you' : 'Most popular'}</option><option value="date">Soonest first</option><option value="price">Price: low to high</option><option value="popular">Fun Score</option></select></div>
      <div id="results"></div>
      <div class="center"><button class="btn ghost" id="more" hidden>Load more</button></div>
    </section>`;
  $('#when').value = f.when; $('#price').value = f.price; $('#mode').value = f.mode; $('#sort').value = f.sort;

  let offset = 0;
  const filtersActive = () => f.q || f.cat !== 'all' || f.when !== 'all' || f.price !== 'all' || f.mode;
  async function loadList(append = false) {
    if (!append) { offset = 0; loading($('#results')); }
    const qs = new URLSearchParams({ city: state.city, q: f.q, cat: f.cat, when: f.when, price: f.price, mode: f.mode, sort: f.sort, offset, limit: 24 });
    try {
      const { items, total } = await api('/events?' + qs);
      const html = items.map(e => card(e)).join('');
      if (append) $('#results .grid').insertAdjacentHTML('beforeend', html);
      else $('#results').innerHTML = items.length ? `<div class="grid">${html}</div>` : `<div class="empty"><h3>No plans here. Yet.</h3><p>Try another category, a different date or a broader search.</p><button class="btn" id="reset">Reset filters</button></div>`;
      $('#reset')?.addEventListener('click', () => { Object.assign(f, { q: '', cat: 'all', when: 'all', price: 'all', mode: '' }); go('#/discover'); });
      offset += items.length;
      $('#count').textContent = `(${total})`;
      $('#more').hidden = offset >= total;
      $('#list-title').firstChild.textContent = filtersActive() ? f.mode === 'online' ? `Online ${f.cat !== 'all' ? cat(f.cat).label.toLowerCase() : 'events'} ` : `${f.cat !== 'all' ? cat(f.cat).label : 'Events'} in ${c.short} ` : `All events in ${c.short} `;
    } catch (e) { errorBox($('#results'), e); }
  }
  async function loadShelves() {
    const box = $('#shelves');
    if (filtersActive()) { box.innerHTML = ''; return; }
    try {
      const [h, onl, sf] = await Promise.all([
        api(`/home?city=${state.city}`), api('/events?city=online&cat=hackathons&sort=date&limit=12').catch(() => ({ items: [] })),
        state.user ? api('/discover/feed').catch(() => null) : null,
      ]);
      const t = h.trending;
      const tabs = [['tonight', 'Hot tonight 🔥'], ['weekend', 'This weekend'], ['sellingFast', 'Almost sold out'], ['free', 'Free today & tomorrow']].filter(([k]) => t[k].length);
      box.innerHTML = `
        <section class="plan-promo">
          <div><p class="eyebrow">✦ AI PLAN MY DAY (EVENTS)</p><h3>Tell us your budget, time and vibe.</h3></div>
          <form id="promo-form"><input id="promo-q" placeholder='"₹1000, Saturday evening, ${esc(c.areas[0]?.name || c.short)}"' aria-label="Describe your plan"><button class="btn primary">Plan it ✦</button></form>
        </section>
        ${sf?.forYou.plans.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">REAL-WORLD PLANS</p><h2>Plans near you</h2></div><a class="link" href="#/plans">See all →</a></div><div class="rail">${sf.forYou.plans.map(planTeaser).join('')}</div></section>` : ''}
        ${h.forYou?.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">PICKED FOR ${esc(state.user.name.split(' ')[0].toUpperCase())}</p><h2>For you</h2></div><a class="link" href="#/me">Tune interests →</a></div>${rail(h.forYou, { reasons: true })}</section>` : ''}
        ${!state.user ? `<section class="signup-nudge"><div><b>Get a feed that knows you.</b><span>Log in for personalised picks, friends' plans and one-tap booking.</span></div><button class="btn primary" id="nudge">Sign up free</button></section>` : ''}
        ${sf?.people.items.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">ONLY PEOPLE WHO OPTED IN</p><h2>People you may want to meet</h2></div></div><div class="rail">${sf.people.items.slice(0, 10).map(personTeaser).join('')}</div></section>` : ''}
        ${tabs.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">TRENDING NEAR YOU</p><h2>What ${esc(c.short)} is into</h2></div></div>
          <div class="tabs" role="tablist">${tabs.map(([k, l], i) => `<button role="tab" class="tab ${i ? '' : 'on'}" data-tab="${k}">${l}</button>`).join('')}</div>
          <div id="trend-rail">${rail(t[tabs[0][0]])}</div></section>` : ''}
        ${sf?.forYou.communities.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">TURN IT INTO A REAL PLAN</p><h2>Communities for you</h2></div><a class="link" href="#/communities">See all →</a></div><div class="rail">${sf.forYou.communities.map(communityTeaser).join('')}</div></section>` : ''}
        ${onl.items.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">🌐 OPEN TO EVERYONE · DEVFOLIO, UNSTOP, DEVPOST & MORE</p><h2>Online hackathons</h2></div><a class="link" href="#/discover?cat=hackathons&mode=online">See all →</a></div>${rail(onl.items)}</section>` : ''}
        ${h.friendsGoing?.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">YOUR PEOPLE</p><h2>Friends are interested</h2></div><a class="link" href="#/friends">Plan together →</a></div>${rail(h.friendsGoing)}</section>` : ''}`;
      $$('[data-tab]', box).forEach(b => b.onclick = () => { $$('[data-tab]', box).forEach(x => x.classList.toggle('on', x === b)); $('#trend-rail').innerHTML = rail(t[b.dataset.tab]); });
      $('#promo-form').onsubmit = e => { e.preventDefault(); go('#/plan?q=' + encodeURIComponent($('#promo-q').value.trim() || $('#promo-q').placeholder.replace(/"/g, ''))); };
      $('#nudge')?.addEventListener('click', () => import('../core.js').then(m => m.openAuth('signup')));
    } catch {}
  }
  $('#home-compose').onsubmit = e => { e.preventDefault(); const q = $('#home-q').value.trim(); if (q) go('#/create?q=' + encodeURIComponent(q)); else go('#/create'); };
  const apply = () => { f.q = $('#q').value.trim(); f.when = $('#when').value; f.price = $('#price').value; f.mode = $('#mode').value; loadShelves(); loadList(); };
  $('#searchbar').onsubmit = e => { e.preventDefault(); apply(); $('#listing').scrollIntoView({ behavior: 'smooth' }); };
  $('#q').oninput = debounce(apply, 350);
  $('#when').onchange = apply; $('#price').onchange = apply; $('#mode').onchange = apply;
  $('#sort').onchange = () => { f.sort = $('#sort').value; loadList(); };
  $$('[data-cat]', el).forEach(b => b.onclick = () => { f.cat = b.dataset.cat; $$('[data-cat]', el).forEach(x => x.classList.toggle('selected', x === b)); loadShelves(); loadList(); });
  $('#more').onclick = () => loadList(true);
  loadShelves(); loadList();
}
