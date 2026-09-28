import { state, api, $, $$, esc, city, grid, avatar, requireAuth, toast, emit, loading } from '../core.js';

export async function saved(el) {
  if (!requireAuth('Log in to see saved events')) { el.innerHTML = `<div class="empty"><h3>Save events you like ♡</h3><p>Log in to keep a list of plans.</p></div>`; return; }
  loading(el);
  const { items } = await api('/saved');
  el.innerHTML = `<p class="eyebrow">SAVED</p><h1>Your shortlist <span class="muted small">(${items.length})</span></h1>
    ${items.length ? grid(items) : `<div class="empty"><h3>Nothing saved yet</h3><p>Tap ♡ on any event to keep it here.</p><a class="btn primary" href="#/discover">Discover events</a></div>`}`;
}

export async function profile(el) {
  if (!requireAuth()) { el.innerHTML = ''; return; }
  const u = state.user;
  const picks = new Set(u.interests);
  const cats = state.meta.interests || state.meta.categories;
  const areas = state.meta.cities.find(c => c.id === u.city)?.areas || [];
  const { items: blocked } = await api('/blocked').catch(() => ({ items: [] }));
  el.innerHTML = `<div class="narrow">
    <p class="eyebrow">PROFILE</p><h1>Hi, ${esc(u.name.split(' ')[0])} 👋</h1>
    <form id="prof" class="stack">
      <label>Name<input name="name" value="${esc(u.name)}" required></label>
      <label>Home city<select name="city">${state.meta.cities.map(c => `<option value="${c.id}" ${c.id === u.city ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>Neighbourhood <small class="muted">(used only as an approximate area for distance — never your exact address)</small>
        <select name="homeArea"><option value="">Not set</option>${areas.map(a => `<option value="${esc(a.name)}" ${a.name === u.homeArea ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <fieldset><legend>Your kind of fun <small>(powers For You, matching & discovery)</small></legend>
        <div class="chips wrap">${cats.map(c => `<button type="button" class="chip ${picks.has(c.id) ? 'selected' : ''}" data-int="${c.id}">${c.icon} ${esc(c.label)}</button>`).join('')}</div></fieldset>
      <label class="friend-pick" style="cursor:pointer"><input type="checkbox" name="discoverable" ${u.discoverable !== false ? 'checked' : ''}><span>Let compatible people discover and invite me<small>Turn off to hide from matching, discovery and "I'm Free" — your existing plans are unaffected.</small></span></label>
      <button class="btn primary big">Save changes</button>
    </form>
    <p class="muted small">Signed in as @${esc(u.username)} · ${esc(u.email)} · ${u.friends} friends</p>
    ${blocked.length ? `<div class="section"><h2 class="sub">Blocked (${blocked.length})</h2><div class="people">${blocked.map(b => `<div class="person">${avatar(b)}<div><b>${esc(b.name)}</b></div><button class="btn small ghost" data-unblock="${b.id}">Unblock</button></div>`).join('')}</div></div>` : ''}
    </div>`;
  $$('[data-int]').forEach(b => b.onclick = () => { const i = b.dataset.int; picks.has(i) ? picks.delete(i) : picks.add(i); b.classList.toggle('selected'); });
  $$('[data-unblock]').forEach(b => b.onclick = async () => { await api(`/users/${b.dataset.unblock}/unblock`, { method: 'POST' }); toast('Unblocked'); profile(el); });
  $('#prof').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { user } = await api('/me', { method: 'PATCH', body: { name: fd.get('name'), city: fd.get('city'), homeArea: fd.get('homeArea') || null, interests: [...picks], discoverable: fd.get('discoverable') === 'on' } });
    state.user = user; state.city = user.city; toast('Saved — your feed is updated'); emit();
  };
}
