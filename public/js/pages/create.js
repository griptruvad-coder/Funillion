import { state, api, $, $$, esc, money, avatar, requireAuth, toast, go, loading, errorBox, modal, closeModal } from '../core.js';

const EXAMPLES = [
  'Anyone up for badminton tomorrow evening?',
  'Want to meet startup founders tonight.',
  'Need 3 people for a café meetup under ₹500.',
  'Looking for people to attend a hackathon this weekend.',
];
let mode = 'describe';
let understood = null;

export async function render(el, _, params) {
  if (!requireAuth('Log in to create a plan and find people')) { el.innerHTML = `<div class="empty"><h3>Tell us what you want to do</h3><p>Log in and Funillion finds the right people for it.</p></div>`; return; }
  const q0 = params?.get('q') || '';
  if (q0) mode = 'describe';
  el.innerHTML = `
  <section class="plan-hero">
    <p class="eyebrow">✦ CREATE A PLAN</p>
    <h1>What do you want<br><em>to do today?</em></h1>
    <div class="auth-tabs" style="max-width:340px;margin-bottom:18px">
      <button class="${mode === 'describe' ? 'on' : ''}" data-mode="describe">Describe it</button>
      <button class="${mode === 'free' ? 'on' : ''}" data-mode="free">I'm Free</button>
    </div>
    <div id="create-body"></div>
  </section>`;
  $$('[data-mode]', el).forEach(b => b.onclick = () => { mode = b.dataset.mode; render(el); });
  if (mode === 'describe') renderDescribe(q0); else renderFree();
}

// ---------------------------------------------------------------- Describe it (AI intent parse)

function renderDescribe(prefill = '') {
  const box = $('#create-body');
  box.innerHTML = `
    <form id="ai-form" class="compose-input"><textarea id="aq" rows="2" maxlength="400" placeholder="e.g. Need 3 people for a café meetup under ₹500">${esc(prefill)}</textarea><button class="btn primary">Find people ✦</button></form>
    <div class="chips wrap">${EXAMPLES.map(x => `<button class="chip" data-ex="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <p class="muted small">Works in English & Hinglish. Funillion turns this into activity, time, budget and group size, then a deterministic matcher finds and ranks real people — the AI never decides who gets invited.</p>
    <div id="ai-out"></div>`;
  $$('[data-ex]', box).forEach(b => b.onclick = () => { $('#aq').value = b.dataset.ex; run(); });
  $('#ai-form').onsubmit = e => { e.preventDefault(); run(); };
  $('#aq').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } };
  if (prefill) run();

  async function run() {
    const text = $('#aq').value.trim();
    if (!text) { $('#aq').focus(); return; }
    const out = $('#ai-out');
    out.innerHTML = `<div class="thinking"><span class="spark">✦</span><div><b>Reading your request…</b><span>Activity → time → budget → group size → radius</span></div></div>`;
    try { understood = (await api('/plans/parse-intent', { method: 'POST', body: { text } })).intent; showUnderstood(text); }
    catch (e) { out.innerHTML = `<div class="empty"><h3>Couldn't read that</h3><p>${esc(e.message)}</p></div>`; }
  }
}

function showUnderstood(rawText) {
  const c = understood;
  const cats = state.meta.interests || state.meta.categories;
  $('#ai-out').innerHTML = `
  <section class="understood">
    <div class="u-head"><p class="eyebrow">UNDERSTOOD AS</p><span class="muted small">${c.parser === 'claude' ? 'Refined by Claude' : 'Funillion NLP'} · tweak anything before creating</span></div>
    <form id="tweak" class="tweak">
      <label>Activity<select name="activity">${cats.map(k => `<option value="${k.id}" ${k.id === c.activity ? 'selected' : ''}>${k.icon} ${esc(k.label)}</option>`).join('')}</select></label>
      <label>Date<input type="date" name="date" value="${c.date}"></label>
      <label>From<input type="time" name="from" value="${c.time_range[0]}"></label>
      <label>Till<input type="time" name="to" value="${c.time_range[1]}"></label>
      <label>Budget (₹ pp)<input type="number" name="budget" min="0" step="50" value="${c.budget ?? ''}" placeholder="No limit"></label>
      <label>People needed<input type="number" name="participants_needed" min="2" max="30" value="${c.participants_needed}"></label>
      <label>Radius (km)<input type="number" name="radius_km" min="0.5" max="50" step="0.5" value="${c.radius_km}"></label>
      <button class="btn dark">Update ↻</button>
    </form>
    <div class="center" style="margin-top:18px"><button class="btn primary big" id="make-plan">Create plan & find people →</button></div>
  </section>`;
  $('#tweak').onsubmit = e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    understood = { ...c, activity: fd.activity, interests: [...new Set([fd.activity, ...c.interests])], date: fd.date, time_range: [fd.from, fd.to], budget: fd.budget === '' ? null : +fd.budget, participants_needed: +fd.participants_needed, radius_km: +fd.radius_km };
    toast('Updated');
    showUnderstood(rawText);
  };
  $('#make-plan').onclick = async () => {
    const btn = $('#make-plan'); btn.disabled = true; btn.textContent = 'Finding people…';
    try {
      const { plan } = await api('/plans', { method: 'POST', body: { text: rawText, noLlm: true, overrides: understood } });
      toast('Plan created — matching people now');
      go('#/plans/' + plan.id);
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Create plan & find people →'; }
  };
}

// ---------------------------------------------------------------- I'm Free

const freeState = { when: 'tonight', customDate: '', customFrom: 18, customTo: 22, budget: '', radiusKm: 5, activities: [], groupSize: 4 };

function renderFree() {
  const box = $('#create-body');
  const cats = state.meta.interests || state.meta.categories;
  if (!freeState.activities.length && state.user?.interests?.length) freeState.activities = state.user.interests.slice(0, 3);
  box.innerHTML = `
  <div class="free-steps">
    <div><p class="free-step-label">WHEN</p>
      <div class="opt-grid">${['now', 'tonight', 'tomorrow', 'custom'].map(w => `<button data-when="${w}" class="${freeState.when === w ? 'on' : ''}">${w === 'now' ? 'Now' : w === 'tonight' ? 'Tonight' : w === 'tomorrow' ? 'Tomorrow' : 'Custom time'}</button>`).join('')}</div>
      <div id="custom-time" class="two" style="margin-top:10px" ${freeState.when === 'custom' ? '' : 'hidden'}>
        <label>Date<input type="date" id="c-date" value="${freeState.customDate}"></label>
        <label>From–To<span style="display:flex;gap:6px"><input type="time" id="c-from" value="${hhmm(freeState.customFrom)}"><input type="time" id="c-to" value="${hhmm(freeState.customTo)}"></span></label>
      </div>
    </div>
    <div><p class="free-step-label">ACTIVITIES</p>
      <div class="chips wrap">${cats.map(k => `<button class="chip ${freeState.activities.includes(k.id) ? 'selected' : ''}" data-act="${k.id}">${k.icon} ${esc(k.label)}</button>`).join('')}</div>
    </div>
    <div class="two">
      <label>Budget (₹ pp, optional)<input type="number" id="f-budget" min="0" step="50" value="${freeState.budget}" placeholder="Any"></label>
      <label>Max distance (km)<input type="number" id="f-radius" min="0.5" max="50" step="0.5" value="${freeState.radiusKm}"></label>
    </div>
    <label>Group size<input type="number" id="f-size" min="2" max="30" value="${freeState.groupSize}"></label>
    <button class="btn im-free-btn big" id="go-free">I'm Free — find something ✦</button>
  </div>
  <div id="free-out"></div>`;
  $$('[data-when]', box).forEach(b => b.onclick = () => { freeState.when = b.dataset.when; renderFree(); });
  $$('[data-act]', box).forEach(b => b.onclick = () => { const i = b.dataset.act; freeState.activities = freeState.activities.includes(i) ? freeState.activities.filter(x => x !== i) : [...freeState.activities, i]; b.classList.toggle('selected'); });
  $('#go-free').onclick = runFree;
}

const parseHM = (v, fallback) => { if (!v) return fallback; const [h, m] = v.split(':').map(Number); return h + m / 60; };
async function runFree() {
  freeState.customDate = $('#c-date')?.value || '';
  freeState.customFrom = parseHM($('#c-from')?.value, 18);
  freeState.customTo = parseHM($('#c-to')?.value, 22);
  freeState.budget = $('#f-budget').value;
  freeState.radiusKm = +$('#f-radius').value || 5;
  freeState.groupSize = +$('#f-size').value || 4;
  const out = $('#free-out');
  loading(out, 'Finding people who are free too…');
  try {
    const { cards } = await api('/discover/im-free', { method: 'POST', body: {
      when: freeState.when, customDate: freeState.customDate, customFrom: freeState.customFrom, customTo: freeState.customTo,
      budget: freeState.budget === '' ? null : +freeState.budget, radiusKm: freeState.radiusKm, activities: freeState.activities, groupSize: freeState.groupSize,
    } });
    renderCards(out, cards);
  } catch (e) { errorBox(out, e); }
}

function renderCards(out, cards) {
  if (!cards.length) { out.innerHTML = `<div class="empty"><h3>Pick an activity above</h3><p>Choose at least one thing you're into and we'll look for people.</p></div>`; return; }
  out.innerHTML = `<div class="suggest-grid">${cards.map((c, i) => `
    <div class="suggest-card" data-card="${i}">
      <div class="suggest-top"><h3>${esc(c.title)}</h3>${c.kind === 'existing' ? '<span class="tag">Open plan</span>' : '<span class="tag outline">New</span>'}</div>
      <div class="suggest-meta"><span>🕐 ${fmtTime(c.startTime)}</span>${c.distanceLabel ? `<span>⌖ ${esc(c.distanceLabel)}</span>` : ''}${c.budgetPerPerson != null ? `<span>${money(c.budgetPerPerson)}/person</span>` : ''}</div>
      ${c.sampleParticipants.length ? `<div class="avatars">${c.sampleParticipants.slice(0, 4).map(u => avatar(u, 'sm')).join('')}<span>${c.interestedCount} ${c.kind === 'existing' ? 'going' : 'compatible nearby'}</span></div>` : `<p class="muted small">Be the first — invite compatible people nearby.</p>`}
      <div class="suggest-actions">
        <button class="btn primary" data-join="${i}">Join</button>
        <button class="btn ghost" data-people="${i}">View people</button>
        <button class="btn ghost" data-ai="${i}">Ask AI</button>
        <button class="btn ghost" data-shift="${i}">Suggest another time</button>
      </div>
    </div>`).join('')}</div>`;

  $$('[data-join]', out).forEach(b => b.onclick = async () => {
    const c = cards[+b.dataset.join]; b.disabled = true; b.textContent = 'Joining…';
    try {
      if (c.kind === 'existing') { await api(`/plans/${c.planId}/join`, { method: 'POST' }); go('#/plans/' + c.planId); }
      else { const { plan } = await api('/plans', { method: 'POST', body: { overrides: c.suggestedIntent } }); go('#/plans/' + plan.id); }
    } catch (e) { toast(e.message, 'error'); b.disabled = false; b.textContent = 'Join'; }
  });
  $$('[data-people]', out).forEach(b => b.onclick = () => {
    const c = cards[+b.dataset.people];
    modal(`<div class="pad-l"><p class="eyebrow">${esc(c.activityLabel.toUpperCase())}</p><h2>Who's around</h2>
      <div class="people">${c.sampleParticipants.map(u => `<div class="person">${avatar(u)}<div><b>${esc(u.name)}</b><small>@${esc(u.username)}</small></div></div>`).join('') || '<p class="muted">No one to show yet — be the first to join.</p>'}</div></div>`);
  });
  $$('[data-ai]', out).forEach(b => b.onclick = () => {
    const c = cards[+b.dataset.ai];
    mode = 'describe';
    $$('.auth-tabs [data-mode]').forEach(x => x.classList.toggle('on', x.dataset.mode === 'describe'));
    renderDescribe(`${c.activityLabel} plan around ${fmtTime(c.startTime)}`);
  });
  $$('[data-shift]', out).forEach(b => b.onclick = async () => {
    const idx = +b.dataset.shift;
    const d = cards[idx].startTime;
    const istHour = (new Date(d).getUTCHours() * 60 + new Date(d).getUTCMinutes() + 330) / 60; // UTC -> IST hour-of-day
    freeState.when = 'custom';
    freeState.customDate = new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);
    freeState.customFrom = Math.min(23.5, istHour + 2);
    freeState.customTo = Math.min(26, freeState.customFrom + 3);
    toast('Looking a couple of hours later…');
    renderFree(); // repopulate the now-visible custom date/time inputs before reading them
    await runFree();
  });
}

const hhmm = h => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
function fmtTime(iso) { return new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }) + ' · ' + new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }); }
