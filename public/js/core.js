// Shared state, API client, formatting and UI helpers
export const state = { user: null, meta: null, city: null, listeners: new Set() };
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'Something went wrong'); err.status = res.status; throw err; }
  return data;
}

// ---------- formatting ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
export const money = n => (n === 0 ? 'Free' : '₹' + Number(n).toLocaleString('en-IN'));
// price shown on cards: listed events may not publish a price
export const priceLabel = (e, short = false) => (e.priceMin == null ? (short ? 'See listing' : 'Price on listing') : e.priceMin === 0 ? 'Free' : (short ? '' : 'From ') + money(e.priceMin));
const TZ = { timeZone: 'Asia/Kolkata' };
export const fmtTime = d => new Date(d).toLocaleTimeString('en-IN', { ...TZ, hour: 'numeric', minute: '2-digit' }).replace(' ', ' ');
export const fmtDay = d => new Date(d).toLocaleDateString('en-IN', { ...TZ, weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDayLong = d => new Date(d).toLocaleDateString('en-IN', { ...TZ, weekday: 'long', day: 'numeric', month: 'long' });
export const dayKey = d => new Date(d).toLocaleDateString('en-CA', TZ);
export function relDay(d) {
  const k = dayKey(d), today = dayKey(new Date()), tmr = dayKey(Date.now() + 86400000);
  return k === today ? 'Today' : k === tmr ? 'Tomorrow' : fmtDay(d);
}
export const monthShort = d => new Date(d).toLocaleDateString('en-IN', { ...TZ, month: 'short' }).toUpperCase();
export const dayNum = d => new Date(d).toLocaleDateString('en-IN', { ...TZ, day: 'numeric' });
export const cat = id => state.meta?.categories.find(c => c.id === id) || { id, label: id, icon: '✳', color: '#e8ebdf', ink: '#181a17' };
export const city = id => state.meta?.cities.find(c => c.id === id) || { id, name: id, short: id, areas: [] };
export const timeAgo = d => { const s = (Date.now() - new Date(d)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : fmtDay(d); };
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function avatar(u, size = '') {
  if (!u) return '';
  const initials = u.initials || (u.name || '?').split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="avatar ${size}" style="--h:${u.avatarHue ?? 90}" title="${esc(u.name)}">${esc(initials)}</span>`;
}

// ---------- posters + cards ----------
function posterLines(title) {
  const words = title.replace(/[:|].*$/, '').split(/\s+/).filter(Boolean).slice(0, 5);
  const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > 11 && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  return lines.slice(0, 3).map(esc).join('<br>');
}
export function poster(e, cls = '') {
  const c = cat(e.category);
  if (e.image) return `<div class="poster photo ${cls}"><img src="img/${esc(e.image)}" alt="" loading="lazy"><span class="poster-title">${posterLines(e.title)}</span></div>`;
  const tilt = (e.id.charCodeAt(e.id.length - 1) % 5) - 2;
  return `<div class="poster typo ${cls}" style="--pc:${c.color};--pi:${c.ink};--tilt:${tilt}deg"><span class="poster-icon" aria-hidden="true">${c.icon}</span><span class="poster-title">${posterLines(e.title)}</span></div>`;
}

// "Cyber Hub" + "Cyber Hub, Gurugram" → "Cyber Hub, Gurugram" (no repeated names)
export function place(e) {
  if (e.online) return '🌐 Online · join from anywhere';
  const v = String(e.venue || ''), a = String(e.area || '');
  if (!a || v.toLowerCase().includes(a.split(',')[0].toLowerCase())) return v || a;
  if (a.toLowerCase().includes(v.toLowerCase())) return a;
  return `${v}, ${a}`;
}
const hackLine = e => {
  const h = e.hack; if (!h) return '';
  const bits = [h.prize && `🏆 ${esc(String(h.prize).slice(0, 28))}`, h.deadline && new Date(h.deadline) > Date.now() && `⏳ Register by ${esc(fmtDay(h.deadline).replace(/^\w+, /, ''))}`].filter(Boolean);
  return bits.length ? `<p class="hack-line">${bits.join(' · ')}</p>` : '';
};
export function card(e, opts = {}) {
  const c = cat(e.category);
  const hot = !e.soldOut && e.fill >= 0.85;
  const friends = e.friends?.length ? `<div class="friend-stack">${e.friends.slice(0, 3).map(f => avatar(f, 'xs')).join('')}<span>${e.friendCount} friend${e.friendCount > 1 ? 's' : ''} interested</span></div>` : '';
  const shownReasons = (e.reasons || []).filter(r => !(friends && /friend/.test(r)));
  const reasons = opts.reasons && shownReasons.length ? `<div class="reasons">${shownReasons.slice(0, 2).map(r => `<span>${esc(r)}</span>`).join('')}</div>` : '';
  return `<article class="card ${opts.compact ? 'compact' : ''}" data-event="${esc(e.id)}">
    <a class="card-link" href="#/event/${esc(e.id)}" aria-label="${esc(e.title)}">
      <div class="poster-wrap">${poster(e)}
        <span class="date-badge">${monthShort(e.start)}<b>${dayNum(e.start)}</b></span>
        ${hot ? '<span class="hot-badge">🔥 Selling fast</span>' : e.soldOut ? '<span class="hot-badge sold">Sold out</span>' : ''}
      </div>
      <div class="card-meta"><span>${c.icon} ${esc(c.label.toUpperCase())}</span><span>${relDay(e.start)}${e.allDay ? '' : ` · ${fmtTime(e.start)}`}</span></div>
      <h3>${esc(e.title)}</h3>
      <p class="venue">${e.online ? '' : '⌖ '}${esc(place(e))}</p>
      ${hackLine(e)}
      ${reasons}${friends}
      <div class="card-bottom"><strong>${priceLabel(e)}</strong><span>${e.ticketing === 'external' && e.bookingSource ? `${e.category === 'hackathons' ? 'Register on' : 'on'} ${esc(e.bookingSource)} ↗` : e.sources.length > 1 ? `✳ ${e.sources.length} platforms` : 'View ↗'}</span></div>
    </a>
    <button class="bookmark ${e.saved ? 'is-saved' : ''}" data-save="${esc(e.id)}" aria-pressed="${e.saved}" aria-label="${e.saved ? 'Unsave' : 'Save'} ${esc(e.title)}">${e.saved ? '♥' : '♡'}</button>
  </article>`;
}
export const rail = (items, opts) => `<div class="rail">${items.map(e => card(e, { ...opts, compact: true })).join('')}</div>`;
export const grid = (items, opts) => `<div class="grid">${items.map(e => card(e, opts)).join('')}</div>`;

// ---------- toast / modal ----------
export function toast(text, kind = '') {
  const t = $('#toast'); t.textContent = text; t.className = `toast show ${kind}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}
export function modal(html, { wide = false, onClose } = {}) {
  const d = $('#modal'); d.className = wide ? 'wide' : '';
  $('#modal-content').innerHTML = html;
  d.onclose = () => { onClose?.(); $('#modal-content').innerHTML = ''; };
  if (!d.open) d.showModal();
  return d;
}
export const closeModal = () => $('#modal').open && $('#modal').close();

export const go = hash => { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; };
export const emit = () => state.listeners.forEach(fn => fn());

// ---------- auth ----------
export function requireAuth(reason = 'Log in to continue') {
  if (state.user) return true;
  openAuth('signup', reason);
  return false;
}

// ask the browser's password manager (Chrome, Edge, Android, iCloud Keychain…) to save the login.
// The password never touches Funillion's storage — it stays in the user's own browser/Google/Apple password manager.
function savePassword(id, password, name) {
  try { if (window.PasswordCredential && id && password) navigator.credentials.store(new PasswordCredential({ id, password, name: name || id })).catch(() => {}); } catch {}
}

export function openAuth(mode = 'login', reason = '') {
  const cities = state.meta.cities;
  const cats = state.meta.interests || state.meta.categories;
  const form = { city: state.city || '', interests: [] };
  const render = (step = mode === 'login' ? 'login' : 'details') => {
    const tabs = `<div class="auth-tabs"><button class="${step === 'login' ? 'on' : ''}" data-step="login">Log in</button><button class="${step !== 'login' ? 'on' : ''}" data-step="details">Sign up</button></div>`;
    let body = '';
    if (step === 'login') body = `
      <form id="login-form" class="stack">
        <label>Username or email<input name="login" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <p class="form-error" hidden></p>
        <button class="btn primary big">Log in</button>
      </form>
      ${state.meta.demo ? `<div class="or"><span>or</span></div>
      <button class="btn ghost big" id="demo-login">Try the demo account (Delhi)</button>` : ''}`;
    if (step === 'details') body = `
      <form id="signup-form" class="stack">
        <div class="two"><label>Your name<input name="name" autocomplete="name" required value="${esc(form.name || '')}"></label>
        <label>Username<input name="username" autocomplete="username" required pattern="[A-Za-z0-9_.]{3,20}" value="${esc(form.username || '')}"></label></div>
        <label>Email<input name="email" type="email" autocomplete="email" required value="${esc(form.email || '')}"></label>
        <label>Password<input name="password" type="password" minlength="6" autocomplete="new-password" required value="${esc(form.password || '')}"></label>
        <p class="form-error" hidden></p>
        <button class="btn primary big">Next: pick your city →</button>
      </form>`;
    if (step === 'city') body = `
      <p class="step-label">STEP 2 OF 3</p><h3 class="step-title">Where do you make plans?</h3>
      <p class="muted">You'll see events from this city first. Switch any time.</p>
      <div class="city-picker">${cities.map(c => `<button class="city-opt ${form.city === c.id ? 'on' : ''}" data-city="${c.id}"><b>${esc(c.short)}</b><span>${esc(c.state)} · ${c.count} events</span></button>`).join('')}</div>
      <button class="btn primary big" id="city-next" ${form.city ? '' : 'disabled'}>Next: what's your kind of fun? →</button>`;
    if (step === 'interests') body = `
      <p class="step-label">STEP 3 OF 3</p><h3 class="step-title">What's your kind of fun?</h3>
      <p class="muted">Pick 3 or more — this powers your For You feed.</p>
      <div class="chips wrap">${cats.map(c => `<button class="chip ${form.interests.includes(c.id) ? 'selected' : ''}" data-int="${c.id}">${c.icon} ${esc(c.label)}</button>`).join('')}</div>
      <p class="form-error" hidden></p>
      <button class="btn primary big" id="finish">Create my account ✳</button>`;
    modal(`<div class="auth">
      <div class="auth-side"><span class="logo light">funillion<span>✳</span></span><h2>A million ways<br>to have fun.</h2><p>${esc(reason || 'Concerts, comedy, hackathons, bhajan clubbing and every plan in between — across India.')}</p></div>
      <div class="auth-main">${['login', 'details'].includes(step) ? tabs : ''}${body}</div></div>`, { wide: true });
    const content = $('#modal-content');
    $$('[data-step]', content).forEach(b => b.onclick = () => render(b.dataset.step));
    const err = msg => { const p = $('.form-error', content); p.textContent = msg; p.hidden = false; };
    $('#login-form', content)?.addEventListener('submit', async ev => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target));
      try { const { user } = await api('/auth/login', { method: 'POST', body: fd }); savePassword(fd.login, fd.password); onLoggedIn(user); } catch (e) { err(e.message); }
    });
    $('#demo-login', content)?.addEventListener('click', async () => { const { user } = await api('/auth/demo', { method: 'POST' }); onLoggedIn(user); });
    $('#signup-form', content)?.addEventListener('submit', ev => { ev.preventDefault(); Object.assign(form, Object.fromEntries(new FormData(ev.target))); render('city'); });
    $$('[data-city]', content).forEach(b => b.onclick = () => { form.city = b.dataset.city; $$('[data-city]', content).forEach(x => x.classList.toggle('on', x === b)); $('#city-next', content).disabled = false; });
    $('#city-next', content)?.addEventListener('click', () => render('interests'));
    $$('[data-int]', content).forEach(b => b.onclick = () => { const i = b.dataset.int; form.interests = form.interests.includes(i) ? form.interests.filter(x => x !== i) : [...form.interests, i]; b.classList.toggle('selected'); });
    $('#finish', content)?.addEventListener('click', async () => {
      try { const { user } = await api('/auth/signup', { method: 'POST', body: form }); savePassword(form.username || form.email, form.password, form.name); onLoggedIn(user, true); }
      catch (e) { if (e.status === 409 || /username|email|password|name/i.test(e.message)) { render('details'); setTimeout(() => err(e.message)); } else err(e.message); }
    });
  };
  render();
}

function onLoggedIn(user, isNew) {
  state.user = user; state.city = user.city;
  closeModal();
  toast(isNew ? `Welcome to Funillion, ${user.name.split(' ')[0]}! Showing ${city(user.city).short}.` : `Welcome back, ${user.name.split(' ')[0]}`);
  emit();
  if (!location.hash || location.hash === '#/' || location.hash === '#/welcome') go('#/discover'); else go(location.hash);
}

export async function setCity(id) {
  state.city = id;
  try { localStorage.setItem('fn-city', id); } catch {}
  if (state.user) { try { const { user } = await api('/me', { method: 'PATCH', body: { city: id } }); state.user = user; } catch {} }
  emit();
}

// global handlers for save buttons (works on any page)
export async function toggleSave(id, btn) {
  if (!requireAuth('Log in to save events to your plans')) return;
  try {
    const { saved, count } = await api(`/events/${id}/save`, { method: 'POST' });
    $$(`[data-save="${CSS.escape(id)}"]`).forEach(b => { b.classList.toggle('is-saved', saved); b.textContent = b.dataset.label ? (saved ? '♥ Saved' : '♡ Save') : saved ? '♥' : '♡'; b.setAttribute('aria-pressed', saved); });
    const sc = $('#save-count'); if (sc) sc.textContent = count;
    toast(saved ? 'Saved to your plans' : 'Removed from saved');
  } catch (e) { toast(e.message, 'error'); }
}

export function loading(el, text = 'Loading…') { el.innerHTML = `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`; }
export function errorBox(el, e) { el.innerHTML = `<div class="empty"><h3>Hmm, that didn't work.</h3><p>${esc(e.message || e)}</p><a class="btn" href="#/discover">Back to discover</a></div>`; }
