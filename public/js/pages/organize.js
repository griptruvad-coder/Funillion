import { state, api, $, $$, esc, money, cat, city, requireAuth, toast, go, loading, relDay, fmtTime, timeAgo } from '../core.js';

let tab = 'aggregation';
export async function render(el, _, params) {
  if (!requireAuth('Log in to list events and see analytics')) { el.innerHTML = `<div class="empty"><h3>For organisers</h3><p>Log in to list events, import from a link and track views, saves and ticket sales.</p></div>`; return; }
  if (params.get('tab')) tab = params.get('tab');
  el.innerHTML = `<div class="org">
    <p class="eyebrow">FOR ORGANISERS</p><h1>List once. Reach all of India.</h1>
    <div class="tabs">${[['aggregation', '✳ Smart aggregation'], ['create', '＋ Add an event'], ['mine', '▤ My events & analytics']].map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div>
    <div id="org-body"></div></div>`;
  $$('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; $$('[data-t]').forEach(x => x.classList.toggle('on', x === b)); show(); });
  const show = () => ({ aggregation, create, mine })[tab]($('#org-body'));
  show();
}

async function aggregation(box) {
  loading(box);
  const { stats: s, sources } = await api('/aggregation');
  const srcs = Object.entries(s.perSource);
  box.innerHTML = `
  <div class="agg">
    <p class="muted">Funillion pulls listings from every platform, normalises their different formats (city spellings, date formats, price fields), detects the same real-world event across sources and merges them into one clean listing.</p>
    <div class="funnel">
      ${srcs.map(([k, v]) => `<div class="src"><b>${esc(v.name)}</b><span>${esc(v.kind)}</span><em>${v.items.toLocaleString('en-IN')} listings</em></div>`).join('')}
      <div class="arrow">→</div>
      <div class="stage"><b>${s.raw.toLocaleString('en-IN')}</b><span>raw listings</span></div>
      <div class="arrow">→</div>
      <div class="stage"><b>${s.merged.toLocaleString('en-IN')}</b><span>duplicates merged</span></div>
      <div class="arrow">→</div>
      <div class="stage lime"><b>${s.totalEvents.toLocaleString('en-IN')}</b><span>unique events</span></div>
    </div>
    <div class="agg-meta"><span>Last run ${timeAgo(s.ranAt)} · ${s.ms} ms</span><button class="btn dark small" id="rerun">↻ Re-run aggregation</button></div>
    <h3>How duplicates are caught</h3>
    <ol class="how"><li><b>Block</b> by city + day so only plausible pairs are compared.</li><li><b>Score</b> title similarity (word overlap + character trigrams, ignoring noise like “LIVE:” or “(2026 Edition)”), start-time gap (≤ 90 min), venue distance and category.</li><li><b>Merge</b> above 0.62: keep the cleanest title, longest description, richest ticket data, lowest price — and link every source.</li></ol>
    <h3>Recent merges</h3>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Incoming listing</th><th>From</th><th>Merged into</th><th>City</th><th>Match</th></tr></thead>
    <tbody>${s.merges.slice(0, 30).map(m => `<tr><td>${esc(m.incoming)}</td><td>${esc(m.source)}</td><td><a class="link" href="#/event/${m.eventId}">${esc(m.into)}</a></td><td>${esc(city(m.city).short)}</td><td><span class="score" style="--s:${m.score}">${Math.round(m.score * 100)}%</span></td></tr>`).join('')}</tbody></table></div>
    <p class="fine">Sources shown are demo feeds with realistic, differing schemas (see <code>data/sources/</code>). Swap in real APIs by writing one adapter each in <code>server/aggregator.js</code>.</p>
  </div>`;
  $('#rerun').onclick = async () => { $('#rerun').textContent = 'Running…'; const { stats } = await api('/aggregation/run', { method: 'POST' }); toast(`Done: ${stats.raw} listings checked · ${stats.created} new · ${stats.updated + stats.merged} matched existing`); aggregation(box); };
}

function create(box, draft = {}) {
  const cities = state.meta.cities;
  const cityId = draft.city || state.city || 'delhi';
  const areas = city(cityId).areas;
  const local = d => { const x = new Date(d); if (isNaN(x)) return ''; const t = new Date(x.getTime() + 330 * 60000); return t.toISOString().slice(0, 16); };
  box.innerHTML = `
  <div class="create">
    <section class="import-box">
      <p class="eyebrow">⚡ EVENT SUBMISSION ENGINE</p><h3>Paste your event link — we'll fill the form</h3>
      <form id="imp" class="imp"><input id="imp-url" type="url" placeholder="https://your-ticketing-or-event-page.com/event/…" required value="${esc(draft.sourceUrl || '')}"><button class="btn dark">Import ↗</button></form>
      <p class="fine" id="imp-msg">Reads schema.org Event data and Open Graph tags that most ticketing and event sites publish. You can edit everything before publishing.</p>
    </section>
    <form id="ev-form" class="stack ev-form">
      <label>Event title<input name="title" required minlength="4" maxlength="120" value="${esc(draft.title || '')}"></label>
      <div class="three">
        <label>Category<select name="category">${state.meta.categories.map(c => `<option value="${c.id}" ${draft.category === c.id ? 'selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('')}</select></label>
        <label>City<select name="city" id="f-city">${cities.map(c => `<option value="${c.id}" ${c.id === cityId ? 'selected' : ''}>${esc(c.short)}</option>`).join('')}</select></label>
        <label>Area<select name="area" id="f-area">${areas.map(a => `<option ${draft.area === a.name ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      </div>
      <div class="three">
        <label>Venue<input name="venue" required maxlength="80" value="${esc(draft.venue || '')}"></label>
        <label>Starts<input name="start" type="datetime-local" required value="${draft.start ? local(draft.start) : ''}"></label>
        <label>Duration (hours)<input name="durH" type="number" min="0.5" max="72" step="0.5" value="${draft.durH ? Math.round(draft.durH * 2) / 2 : 2}"></label>
      </div>
      <label>Description<textarea name="description" rows="4" maxlength="2000">${esc(draft.description || '')}</textarea></label>
      <fieldset><legend>Tickets</legend><div id="tiers"></div><button type="button" class="btn small ghost" id="add-tier">＋ Add ticket type</button></fieldset>
      <input type="hidden" name="sourceUrl" value="${esc(draft.sourceUrl || '')}"><input type="hidden" name="image" value="${esc(draft.image || '')}">
      <p class="form-error" hidden></p>
      <button class="btn primary big">Publish on Funillion</button>
      <p class="fine">Before publishing we check for duplicates — if this event is already listed from another platform, your listing is merged into it (you become the verified organiser).</p>
    </form>
    <div id="publish-result"></div>
  </div>`;
  const tiers = draft.price != null ? [{ name: draft.price ? 'General' : 'Free entry', price: draft.price, capacity: 100 }] : [{ name: 'General', price: 499, capacity: 100 }];
  const drawTiers = () => {
    $('#tiers').innerHTML = tiers.map((t, i) => `<div class="tier-row"><input data-i="${i}" data-k="name" value="${esc(t.name)}" placeholder="Name" aria-label="Ticket name"><input data-i="${i}" data-k="price" type="number" min="0" value="${t.price}" aria-label="Price ₹"><input data-i="${i}" data-k="capacity" type="number" min="1" value="${t.capacity}" aria-label="Capacity">${tiers.length > 1 ? `<button type="button" class="btn small ghost" data-rm="${i}">✕</button>` : ''}</div>`).join('');
    $$('#tiers input').forEach(inp => inp.oninput = () => { tiers[inp.dataset.i][inp.dataset.k] = inp.dataset.k === 'name' ? inp.value : +inp.value; });
    $$('[data-rm]').forEach(b => b.onclick = () => { tiers.splice(+b.dataset.rm, 1); drawTiers(); });
  };
  drawTiers();
  $('#add-tier').onclick = () => { tiers.push({ name: 'VIP', price: 999, capacity: 30 }); drawTiers(); };
  $('#f-city').onchange = e => { $('#f-area').innerHTML = city(e.target.value).areas.map(a => `<option>${esc(a.name)}</option>`).join(''); };
  $('#imp').onsubmit = async e => {
    e.preventDefault();
    $('#imp-msg').textContent = 'Reading the page…';
    try {
      const { draft: d } = await api('/organizer/import', { method: 'POST', body: { url: $('#imp-url').value.trim() } });
      create(box, d);
      $('#imp-msg').textContent = `✓ Imported ${d.confidence.fields.length} fields (${d.confidence.fields.join(', ') || 'none'})${d.confidence.structured ? ' from structured event data' : ' from page tags'}. Review and publish.`;
    } catch (err) { $('#imp-msg').textContent = '✕ ' + err.message + ' — you can still fill the form manually.'; }
  };
  $('#ev-form').onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const start = new Date(fd.start + ':00+05:30');
    try {
      const r = await api('/organizer/events', { method: 'POST', body: { ...fd, start: start.toISOString(), durH: +fd.durH, tiers } });
      $('#publish-result').innerHTML = `<div class="result ${r.action}"><b>${r.action === 'merged' ? '✳ Already on Funillion — merged!' : '✓ Published!'}</b><p>${r.action === 'merged' ? `We found “${esc(r.matchedTitle)}” listed from another platform (${Math.round(r.score * 100)}% match). Your listing was merged into it and you're now the verified organiser.` : 'Your event is live and discoverable in feeds, the map and AI plans.'}</p><a class="btn primary" href="#/event/${r.event.id}">View listing →</a></div>`;
      $('#publish-result').scrollIntoView({ behavior: 'smooth' });
    } catch (err) { const p = $('.form-error', box); p.textContent = err.message; p.hidden = false; }
  };
}

async function mine(box) {
  loading(box);
  const { items } = await api('/organizer/events');
  if (!items.length) { box.innerHTML = `<div class="empty"><h3>No events yet</h3><p>Add your first event — it takes a minute, or paste a link.</p><button class="btn primary" id="go-create">＋ Add an event</button></div>`; $('#go-create').onclick = () => $('[data-t="create"]').click(); return; }
  const tot = items.reduce((a, e) => ({ views: a.views + e.stats.views, saves: a.saves + e.stats.saves, tickets: a.tickets + e.ticketsSold, revenue: a.revenue + e.revenue }), { views: 0, saves: 0, tickets: 0, revenue: 0 });
  box.innerHTML = `
    <div class="kpis"><div><b>${tot.views}</b><span>views</span></div><div><b>${tot.saves}</b><span>saves</span></div><div><b>${tot.tickets}</b><span>tickets sold</span></div><div><b>${money(tot.revenue)}</b><span>revenue</span></div></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Event</th><th>When</th><th>Views</th><th>Clicks</th><th>Saves</th><th>Tickets</th><th>Revenue</th><th>Sold</th></tr></thead>
    <tbody>${items.map(e => `<tr><td><a class="link" href="#/event/${e.id}">${esc(e.title)}</a><br><small class="muted">${esc(city(e.city).short)} · ${e.sources.join(' + ')}</small></td><td>${relDay(e.start)} ${fmtTime(e.start)}</td><td>${e.stats.views}</td><td>${e.stats.clicks}</td><td>${e.stats.saves}</td><td>${e.ticketsSold}</td><td>${money(e.revenue)}</td><td><div class="vote-bar"><i style="width:${Math.round(e.fill * 100)}%"></i></div></td></tr>`).join('')}</tbody></table></div>`;
}
