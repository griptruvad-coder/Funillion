import { state, api, $, $$, esc, city, cat, emit, go, openAuth, setCity, toggleSave, avatar, toast, closeModal, modal } from './core.js';
import * as discover from './pages/discover.js';
import * as landing from './pages/landing.js';
import * as eventPage from './pages/event.js';
import * as booking from './pages/booking.js';
import * as mapPage from './pages/map.js';
import * as plan from './pages/plan.js';
import * as social from './pages/social.js';
import * as organize from './pages/organize.js';
import * as account from './pages/account.js';

const routes = [
  [/^#?\/?$/, () => (state.user ? discover.render : landing.render)],
  [/^#\/discover$/, () => discover.render],
  [/^#\/event\/([\w-]+)$/, () => eventPage.render],
  [/^#\/checkout\/([\w-]+)$/, () => booking.checkout],
  [/^#\/ticket\/([\w-]+)$/, () => booking.ticket],
  [/^#\/tickets$/, () => booking.tickets],
  [/^#\/map$/, () => mapPage.render],
  [/^#\/plan$/, () => plan.render],
  [/^#\/friends$/, () => social.friends],
  [/^#\/group\/([\w-]+)$/, () => social.group],
  [/^#\/join\/([\w-]+)$/, () => social.join],
  [/^#\/saved$/, () => account.saved],
  [/^#\/organize$/, () => organize.render],
  [/^#\/me$/, () => account.profile],
];
let cleanup = null;

async function router() {
  const [path, query = ''] = (location.hash || '#/').split('?');
  const params = new URLSearchParams(query);
  if (typeof cleanup === 'function') { try { cleanup(); } catch {} }
  cleanup = null;
  closeModal();
  const el = $('#app');
  for (const [re, getPage] of routes) {
    const m = path.match(re);
    if (m) {
      window.scrollTo(0, 0);
      el.className = '';
      cleanup = await getPage()(el, m[1], params);
      renderHeader();
      return;
    }
  }
  el.innerHTML = `<div class="empty"><h3>Page not found</h3><a class="btn" href="#/">Go home</a></div>`;
}

function renderHeader() {
  const u = state.user, c = city(state.city);
  const path = (location.hash || '#/').split('?')[0];
  const active = p => (path.startsWith(p) || (p === '#/discover' && (path === '#/' || path === '')) ? 'active' : '');
  const links = [['#/discover', 'Discover', '✳'], ['#/map', 'Map', '⌖'], ['#/plan', 'Plan my day', '✦'], ['#/friends', 'Friends', '☺'], ['#/tickets', 'Tickets', '▤']];
  $('#header').innerHTML = `
    <a class="logo" href="#/">funillion<span>✳</span></a>
    <nav class="top-nav">${links.map(([h, l]) => `<a class="nav ${active(h)}" href="${h}">${l}${h === '#/plan' ? ' <em>AI</em>' : ''}</a>`).join('')}</nav>
    <button class="city-btn" id="city-btn" aria-haspopup="true">⌖ <span>${esc(c.short || 'Pick city')}</span> ▾</button>
    ${u ? `<a class="icon-btn" href="#/saved" aria-label="Saved events">♡</a>
      <div class="menu-wrap"><button class="avatar-btn" id="avatar-btn" aria-label="Account menu">${avatar(u)}</button>
      <div class="menu" id="user-menu" hidden><div class="menu-head"><b>${esc(u.name)}</b><span>@${esc(u.username)}</span></div>
        <a href="#/me">Profile & interests</a><a href="#/saved">Saved events</a><a href="#/tickets">My tickets</a><a href="#/organize">Organizer & aggregation</a><button id="logout">Log out</button></div></div>`
      : `<button class="btn ghost small" id="login-btn">Log in</button><button class="btn primary small" id="signup-btn">Sign up</button>`}`;
  $('#tabbar').innerHTML = links.map(([h, l, i]) => `<a class="${active(h)}" href="${h}"><span>${i}</span>${l.split(' ')[0]}</a>`).join('');
  $('#city-btn').onclick = openCityPicker;
  $('#login-btn')?.addEventListener('click', () => openAuth('login'));
  $('#signup-btn')?.addEventListener('click', () => openAuth('signup'));
  $('#avatar-btn')?.addEventListener('click', e => { e.stopPropagation(); const m = $('#user-menu'); m.hidden = !m.hidden; });
  $('#logout')?.addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); state.user = null; toast('Logged out'); emit(); go('#/'); });
}
document.addEventListener('click', e => { const m = $('#user-menu'); if (m && !m.hidden && !e.target.closest('.menu-wrap')) m.hidden = true; });

export function openCityPicker() {
  const byState = state.meta.cities;
  modal(`<div class="city-modal"><p class="eyebrow">FUNILLION IS LIVE IN ${byState.length} CITIES</p><h2>Where are you making plans?</h2>
    <label class="search small"><span>⌕</span><input id="city-filter" placeholder="Search a city…" autocomplete="off"></label>
    <div class="city-picker">${byState.map(c => `<button class="city-opt ${state.city === c.id ? 'on' : ''}" data-pick="${c.id}"><b>${esc(c.short)}</b><span>${esc(c.state)} · ${c.count} events</span></button>`).join('')}</div>
    <p class="muted small">More cities coming soon — tell organisers to list on Funillion.</p></div>`);
  $('#city-filter').oninput = e => $$('[data-pick]').forEach(b => b.hidden = !b.textContent.toLowerCase().includes(e.target.value.toLowerCase()));
  $$('[data-pick]').forEach(b => b.onclick = async () => { closeModal(); await setCity(b.dataset.pick); toast(`Showing events in ${city(b.dataset.pick).short}`); });
}

// global delegated actions
document.addEventListener('click', e => {
  const s = e.target.closest('[data-save]');
  if (s) { e.preventDefault(); e.stopPropagation(); toggleSave(s.dataset.save, s); }
  const cardLink = e.target.closest('.card-link');
  if (cardLink) { const id = cardLink.closest('[data-event]')?.dataset.event; if (id) navigator.sendBeacon?.(`/api/events/${id}/track`, new Blob([JSON.stringify({ type: 'click' })], { type: 'application/json' })); }
});

async function boot() {
  const [meta, me] = await Promise.all([api('/meta'), api('/me')]);
  state.meta = meta; state.user = me.user;
  let saved = null; try { saved = localStorage.getItem('fn-city'); } catch {}
  state.city = state.user?.city || saved || null;
  state.listeners.add(() => { renderHeader(); router(); });
  window.addEventListener('hashchange', router);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  $('#modal-close').onclick = closeModal;
  await router();
  if (!state.city && !state.user) setTimeout(() => { if (!state.city && location.hash.startsWith('#/discover')) openCityPicker(); }, 300);
}
boot().catch(e => { $('#app').innerHTML = `<div class="empty"><h3>Funillion couldn't start</h3><p>${esc(e.message)}. Is the server running? Start it with <code>node server.js</code>.</p></div>`; });
