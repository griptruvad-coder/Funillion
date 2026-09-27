import { state, api, $, $$, esc, city, cat, rail, card, go, loading, errorBox, debounce } from '../core.js';
import { openCityPicker } from '../app.js';

const f = { q: '', cat: 'all', when: 'all', price: 'all', sort: 'recommended' };
let lastCity = null;

export async function render(el, _, params) {
  if (!state.city) { el.innerHTML = `<div class="empty"><h3>Pick a city to start</h3><p>Funillion is live across India.</p><button class="btn primary" id="pick">Choose city</button></div>`; $('#pick').onclick = openCityPicker; openCityPicker(); return; }
  if (lastCity !== state.city) { Object.assign(f, { q: '', cat: 'all', when: 'all', price: 'all' }); lastCity = state.city; }
  if (params.get('cat')) f.cat = params.get('cat');
  if (params.get('q') !== null) f.q = params.get('q') || '';
  if (params.get('when')) f.when = params.get('when');
  const c = city(state.city);
  const first = state.user ? state.user.name.split(' ')[0] : null;
  el.innerHTML = `
    <section class="disc-hero">
      <p class="eyebrow">GOOD PEOPLE. GREAT PLANS. ${esc(c.short.toUpperCase())}.</p>
      <div class="title-line"><h1>${first ? `${esc(first)}, what's the plan <em>in ${esc(c.short)}?</em>` : `What's the plan <em>in ${esc(c.short)}?</em>`}</h1><span class="edition">${c.count} EVENTS<br>NEXT 3 WEEKS</span></div>
      <form class="searchbar" id="searchbar">
        <label class="search"><span>⌕</span><input id="q" value="${esc(f.q)}" placeholder="Artists, events, venues or a neighbourhood…" aria-label="Search events"></label>
        <select id="when" aria-label="Date"><option value="all">Any date</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="weekend">This weekend</option><option value="week">Next 7 days</option></select>
        <select id="price" aria-label="Price"><option value="all">Any price</option><option value="free">Free</option><option value="500">Under ₹500</option><option value="1000">Under ₹1,000</option><option value="2000">Under ₹2,000</option></select>
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
  $('#when').value = f.when; $('#price').value = f.price; $('#sort').value = f.sort;

  let offset = 0;
  const filtersActive = () => f.q || f.cat !== 'all' || f.when !== 'all' || f.price !== 'all';
  async function loadList(append = false) {
    if (!append) { offset = 0; loading($('#results')); }
    const qs = new URLSearchParams({ city: state.city, q: f.q, cat: f.cat, when: f.when, price: f.price, sort: f.sort, offset, limit: 24 });
    try {
      const { items, total } = await api('/events?' + qs);
      const html = items.map(e => card(e)).join('');
      if (append) $('#results .grid').insertAdjacentHTML('beforeend', html);
      else $('#results').innerHTML = items.length ? `<div class="grid">${html}</div>` : `<div class="empty"><h3>No plans here. Yet.</h3><p>Try another category, a different date or a broader search.</p><button class="btn" id="reset">Reset filters</button></div>`;
      $('#reset')?.addEventListener('click', () => { Object.assign(f, { q: '', cat: 'all', when: 'all', price: 'all' }); go('#/discover'); });
      offset += items.length;
      $('#count').textContent = `(${total})`;
      $('#more').hidden = offset >= total;
      $('#list-title').firstChild.textContent = filtersActive() ? `${f.cat !== 'all' ? cat(f.cat).label : 'Events'} in ${c.short} ` : `All events in ${c.short} `;
    } catch (e) { errorBox($('#results'), e); }
  }
  async function loadShelves() {
    const box = $('#shelves');
    if (filtersActive()) { box.innerHTML = ''; return; }
    try {
      const h = await api(`/home?city=${state.city}`);
      const t = h.trending;
      const tabs = [['tonight', 'Hot tonight 🔥'], ['weekend', 'This weekend'], ['sellingFast', 'Almost sold out'], ['free', 'Free today & tomorrow']].filter(([k]) => t[k].length);
      box.innerHTML = `
        <section class="plan-promo">
          <div><p class="eyebrow">✦ AI PLAN MY DAY</p><h3>Tell us your budget, time and vibe.</h3></div>
          <form id="promo-form"><input id="promo-q" placeholder='"₹1000, Saturday evening, ${esc(c.areas[0]?.name || c.short)}"' aria-label="Describe your plan"><button class="btn primary">Plan it ✦</button></form>
        </section>
        ${h.forYou?.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">PICKED FOR ${esc(state.user.name.split(' ')[0].toUpperCase())}</p><h2>For you</h2></div><a class="link" href="#/me">Tune interests →</a></div>${rail(h.forYou, { reasons: true })}</section>` : ''}
        ${!state.user ? `<section class="signup-nudge"><div><b>Get a feed that knows you.</b><span>Log in for personalised picks, friends' plans and one-tap booking.</span></div><button class="btn primary" id="nudge">Sign up free</button></section>` : ''}
        ${tabs.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">TRENDING NEAR YOU</p><h2>What ${esc(c.short)} is into</h2></div></div>
          <div class="tabs" role="tablist">${tabs.map(([k, l], i) => `<button role="tab" class="tab ${i ? '' : 'on'}" data-tab="${k}">${l}</button>`).join('')}</div>
          <div id="trend-rail">${rail(t[tabs[0][0]])}</div></section>` : ''}
        ${h.friendsGoing?.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">YOUR PEOPLE</p><h2>Friends are interested</h2></div><a class="link" href="#/friends">Plan together →</a></div>${rail(h.friendsGoing)}</section>` : ''}`;
      $$('[data-tab]', box).forEach(b => b.onclick = () => { $$('[data-tab]', box).forEach(x => x.classList.toggle('on', x === b)); $('#trend-rail').innerHTML = rail(t[b.dataset.tab]); });
      $('#promo-form').onsubmit = e => { e.preventDefault(); go('#/plan?q=' + encodeURIComponent($('#promo-q').value.trim() || $('#promo-q').placeholder.replace(/"/g, ''))); };
      $('#nudge')?.addEventListener('click', () => import('../core.js').then(m => m.openAuth('signup')));
    } catch {}
  }
  const apply = () => { f.q = $('#q').value.trim(); f.when = $('#when').value; f.price = $('#price').value; loadShelves(); loadList(); };
  $('#searchbar').onsubmit = e => { e.preventDefault(); apply(); $('#listing').scrollIntoView({ behavior: 'smooth' }); };
  $('#q').oninput = debounce(apply, 350);
  $('#when').onchange = apply; $('#price').onchange = apply;
  $('#sort').onchange = () => { f.sort = $('#sort').value; loadList(); };
  $$('[data-cat]', el).forEach(b => b.onclick = () => { f.cat = b.dataset.cat; $$('[data-cat]', el).forEach(x => x.classList.toggle('selected', x === b)); loadShelves(); loadList(); });
  $('#more').onclick = () => loadList(true);
  loadShelves(); loadList();
}
