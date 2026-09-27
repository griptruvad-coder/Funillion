import { state, api, $, $$, esc, money, cat, city, avatar, requireAuth, toast, go, modal, closeModal } from '../core.js';

const EXAMPLES = [
  '₹1000 budget, Saturday evening, South Delhi',
  'couple ke liye ₹1500 me plan, kal shaam, Bandra',
  'aaj raat kya karu? 3 friends, 2k budget',
  'best hackathon this weekend in Bangalore',
  'Sunday morning chill plan in Pune, no party',
  'Koramangala me aaj raat party, 4 log, 5000',
];
let last = null;
let map = null;

export async function render(el, _, params) {
  const q0 = params.get('q') || '';
  el.innerHTML = `
  <section class="plan-hero">
    <p class="eyebrow">✦ AI PLAN MY DAY</p>
    <h1>Tell us the vibe.<br><em>We'll plan the day.</em></h1>
    <form id="plan-form" class="plan-input">
      <textarea id="pq" rows="2" maxlength="400" placeholder="e.g. ₹1000 budget, Saturday evening, South Delhi — comedy then something chill">${esc(q0)}</textarea>
      <button class="btn primary big">Plan it ✦</button>
    </form>
    <div class="chips wrap">${EXAMPLES.map(x => `<button class="chip" data-ex="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <p class="muted small">Works in English & Hinglish. Understands budget, date, time of day, area, group size, vibe ("date", "chill", "masti") and categories.</p>
  </section>
  <div id="plan-out"></div>`;
  $$('[data-ex]').forEach(b => b.onclick = () => { $('#pq').value = b.dataset.ex; run(); });
  $('#plan-form').onsubmit = e => { e.preventDefault(); run(); };
  $('#pq').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } };
  if (q0) run(); else if (last) show(last);
  return () => { map?.remove(); map = null; };
}

async function run(overrides) {
  const q = $('#pq').value.trim();
  if (!q) { $('#pq').focus(); return; }
  const out = $('#plan-out');
  out.innerHTML = `<div class="thinking"><span class="spark">✦</span><div><b>Planning…</b><span>Reading your budget, time & vibe → scanning events → checking travel times → optimising</span></div></div>`;
  try {
    const r = await api('/plan', { method: 'POST', body: { query: q, overrides } });
    last = r; show(r);
  } catch (e) { out.innerHTML = `<div class="empty"><h3>Couldn't plan that</h3><p>${esc(e.message)}</p></div>`; }
}

const hourOpts = (sel) => Array.from({ length: 27 }, (_, h) => `<option value="${h}" ${Math.round(sel) === h ? 'selected' : ''}>${h === 0 ? 'Midnight' : h < 12 ? h + ' am' : h === 12 ? 'Noon' : h < 24 ? (h - 12) + ' pm' : (h - 24) + ' am (late)'}</option>`).join('');

function show(r) {
  const out = $('#plan-out');
  const c = r.constraints, cty = city(c.city);
  map?.remove(); map = null;
  out.innerHTML = `
  <section class="understood">
    <div class="u-head"><p class="eyebrow">UNDERSTOOD AS</p><span class="muted small">Parsed by ${r.parser === 'claude' ? 'Claude' : 'Funillion NLP'} · tweak anything and re-plan</span></div>
    <form id="tweak" class="tweak">
      <label>City<select name="city">${state.meta.cities.map(x => `<option value="${x.id}" ${x.id === c.city ? 'selected' : ''}>${esc(x.short)}</option>`).join('')}</select></label>
      <label>Date<input type="date" name="date" value="${c.date}"></label>
      <label>From<select name="from">${hourOpts(c.from)}</select></label>
      <label>Till<select name="to">${hourOpts(c.to)}</select></label>
      <label>Budget (total ₹)<input type="number" name="budget" min="0" step="100" value="${c.budget ?? ''}" placeholder="No limit"></label>
      <label>People<input type="number" name="people" min="1" max="20" value="${c.people}"></label>
      <label>Area<select name="zone"><option value="">Anywhere in ${esc(cty.short)}</option>${[...new Set(cty.areas.map(a => a.zone))].map(z => `<option value="${z}" ${c.zone === z ? 'selected' : ''}>${z === 'ncr' ? 'Gurugram / Noida' : z[0].toUpperCase() + z.slice(1) + ' ' + esc(cty.short)}</option>`).join('')}</select></label>
      <label>Stops<select name="maxStops">${[1, 2, 3, 4].map(n => `<option ${n === c.maxStops ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="btn dark">Re-plan ↻</button>
    </form>
    ${c.categories.length || c.vibe || c.exclude.length ? `<div class="chips wrap small">${c.categories.map(k => `<span class="chip static">${cat(k).icon} ${esc(cat(k).label)}</span>`).join('')}${c.vibe ? `<span class="chip static">vibe: ${esc(c.vibe)}</span>` : ''}${c.exclude.map(k => `<span class="chip static strike">no ${esc(cat(k).label)}</span>`).join('')}</div>` : ''}
    ${r.notes.map(n => `<p class="note">ⓘ ${esc(n)}</p>`).join('')}
  </section>
  ${r.plans.length ? `
  <section class="plans">
    <div class="tabs">${r.plans.map((p, i) => `<button class="tab ${i ? '' : 'on'}" data-plan="${i}">Plan ${'ABC'[i]} · ${money(p.totalCost)}</button>`).join('')}</div>
    <div class="plan-grid"><div id="plan-detail"></div><div id="plan-map" class="plan-map"></div></div>
  </section>` : `<div class="empty"><h3>No plan fits yet</h3><p>Try raising the budget, widening the time window or picking another day.</p></div>`}`;
  $('#tweak').onsubmit = e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    run({ city: fd.city, date: fd.date, from: +fd.from, to: +fd.to, budget: fd.budget === '' ? null : +fd.budget, people: +fd.people, zone: fd.zone || null, maxStops: +fd.maxStops });
  };
  if (!r.plans.length) return;
  $$('[data-plan]').forEach(b => b.onclick = () => { $$('[data-plan]').forEach(x => x.classList.toggle('on', x === b)); showPlan(r, +b.dataset.plan); });
  showPlan(r, 0);
}

function showPlan(r, i) {
  const p = r.plans[i], c = r.constraints;
  const events = p.steps.filter(s => s.type === 'event');
  $('#plan-detail').innerHTML = `
    <div class="plan-card">
      <div class="plan-top"><div><p class="eyebrow">${esc(r.dateLabel.toUpperCase())} · ${esc(city(c.city).short.toUpperCase())}</p><h2>${esc(p.title)}</h2></div>
        <div class="plan-cost"><b>${money(p.totalCost)}</b><span>${c.people > 1 ? `${money(p.perPerson)} × ${c.people} people` : 'total'}${c.budget != null ? ` · budget ${money(c.budget)}` : ''}</span></div></div>
      <ol class="timeline">${p.steps.map(s => {
        if (s.type === 'travel') return `<li class="t-travel"><span>${s.mode === 'Walk' ? '🚶' : '🛺'}</span>${esc(s.mode)} · ${s.minutes} min · ${s.km} km${s.from !== s.to ? ` → ${esc(s.to)}` : ''}</li>`;
        if (s.type === 'break') return `<li class="t-break"><span>☕</span>${esc(s.text)} · ${Math.round(s.minutes / 5) * 5} min</li>`;
        const k = cat(s.category);
        return `<li class="t-event"><div class="t-time"><b>${esc(s.arrive)}</b><small>till ${esc(s.leave)}</small></div>
          <a class="t-body" href="#/event/${s.eventId}"><span class="dot" style="--pc:${k.color};--pi:${k.ink}">${k.icon}</span><div><b>${esc(s.title)}</b><small>${esc(s.venue)}, ${esc(s.area)} · ${esc(s.tierName)} ${s.pricePerPerson ? money(s.pricePerPerson) + (c.people > 1 ? ' pp' : '') : '· Free'}</small>${s.why?.length ? `<em>${s.why.map(esc).join(' · ')}</em>` : ''}${s.leavesEarly ? '<em class="warn">Leave a little early to make the next stop</em>' : ''}</div></a></li>`;
      }).join('')}</ol>
      <div class="plan-actions">
        <a class="btn primary" href="#/event/${events[0].eventId}">Book first stop →</a>
        <button class="btn dark" id="send-friends">☺ Send to friends</button>
        <button class="btn ghost" id="save-all">♡ Save all stops</button>
      </div>
      <p class="fine">Arrive times include a 10-minute buffer. Travel estimates use distance and typical city speed.</p>
    </div>`;
  // map with route
  map?.remove(); map = null;
  if (window.L) {
    map = L.map('plan-map', { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    const pts = events.map(s => [s.lat, s.lng]);
    events.forEach((s, n) => { const k = cat(s.category); L.marker([s.lat, s.lng], { icon: L.divIcon({ className: 'pin', html: `<span style="--pc:${k.color};--pi:${k.ink}"><i>${n + 1}</i></span>`, iconSize: [34, 34], iconAnchor: [17, 34] }) }).addTo(map).bindTooltip(`${n + 1}. ${s.title}`); });
    if (pts.length > 1) L.polyline(pts, { color: '#181a17', weight: 3, dashArray: '6 8' }).addTo(map);
    if (pts.length === 1) map.setView(pts[0], 14); else map.fitBounds(pts, { padding: [40, 40] });
  }
  $('#save-all').onclick = async () => {
    if (!requireAuth('Log in to save plans')) return;
    for (const s of events) { const ev = await api('/events/' + s.eventId); if (!ev.event.saved) await api(`/events/${s.eventId}/save`, { method: 'POST' }); }
    toast(`Saved ${events.length} stop${events.length > 1 ? 's' : ''} to your plans`);
  };
  $('#send-friends').onclick = async () => {
    if (!requireAuth('Log in to plan with friends')) return;
    const fr = await api('/friends');
    modal(`<div class="pad-l"><p class="eyebrow">SEND TO FRIENDS</p><h2>Make it a group plan</h2><p class="muted">Everyone gets the itinerary, can vote on the stops and chat.</p>
      <form id="gp" class="stack"><input name="name" value="${esc(p.title.slice(0, 40))}" required maxlength="50">
      ${fr.friends.length ? `<div class="pick-friends">${fr.friends.map(f => `<label class="friend-pick"><input type="checkbox" name="m" value="${f.id}" ${f.cityName === city(c.city).short ? 'checked' : ''}>${avatar(f, 'sm')}<span>${esc(f.name)}<small>${esc(f.cityName)}</small></span></label>`).join('')}</div>` : '<p class="muted">No friends yet — you\'ll get an invite link to share.</p>'}
      <button class="btn primary big">Create group plan</button></form></div>`);
    $('#gp').onsubmit = async ev => {
      ev.preventDefault(); const fd = new FormData(ev.target);
      const note = `✦ AI plan for ${r.dateLabel}: ` + events.map(s => `${s.arrive} ${s.title}`).join(' → ') + ` · ${money(p.totalCost)} total`;
      const { group } = await api('/groups', { method: 'POST', body: { name: fd.get('name'), memberIds: fd.getAll('m'), eventIds: events.map(s => s.eventId), city: c.city, note } });
      closeModal(); go('#/group/' + group.id);
    };
  };
}
