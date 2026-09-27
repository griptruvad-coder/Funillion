import { state, api, $, $$, esc, money, priceLabel, cat, city, avatar, card, requireAuth, toast, go, modal, closeModal, loading, errorBox, relDay, fmtTime, timeAgo, debounce, poster } from '../core.js';

export async function friends(el) {
  if (!requireAuth('Log in to find friends and plan together')) { el.innerHTML = `<div class="empty"><h3>Plans are better together</h3><p>Log in to add friends, see what they're into and make group plans.</p></div>`; return; }
  loading(el);
  const [fr, { items: groups }] = await Promise.all([api('/friends'), api('/groups')]);
  el.innerHTML = `
  <div class="social-layout">
    <section>
      <div class="section-head"><div><p class="eyebrow">GROUP PLANS</p><h1>Plan with your people</h1></div><button class="btn primary" id="new-plan">＋ New group plan</button></div>
      ${groups.length ? `<div class="group-list">${groups.map(g => `<a class="group-card" href="#/group/${g.id}">
          <div class="gc-top"><b>${esc(g.name)}</b><span class="muted small">${esc(city(g.city).short)}</span></div>
          <div class="avatars">${g.members.slice(0, 5).map(m => avatar(m, 'sm')).join('')}<span>${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}</span></div>
          ${g.finalEvent ? `<p class="locked">🎉 Locked: ${esc(g.finalEvent.title)} · ${relDay(g.finalEvent.start)}</p>` : `<p class="muted small">${g.candidates} option${g.candidates === 1 ? '' : 's'} on the table · voting open</p>`}
          ${g.lastMessage ? `<p class="last-msg">“${esc(g.lastMessage.slice(0, 80))}”</p>` : ''}</a>`).join('')}</div>`
      : `<div class="empty small"><h3>No group plans yet</h3><p>Start one, add a few events, and let friends vote.</p></div>`}
    </section>
    <aside class="friends-col">
      <p class="eyebrow">FRIENDS (${fr.friends.length})</p>
      <label class="search small"><span>⌕</span><input id="user-q" placeholder="Find people by name or username" autocomplete="off"></label>
      <div id="user-results"></div>
      ${fr.incoming.length ? `<h4>Requests</h4>${fr.incoming.map(u => `<div class="person">${avatar(u)}<div><b>${esc(u.name)}</b><small>@${esc(u.username)}</small></div><button class="btn small primary" data-accept="${u.id}">Accept</button><button class="btn small ghost" data-decline="${u.id}">✕</button></div>`).join('')}` : ''}
      <div class="people">${fr.friends.map(u => `<div class="person">${avatar(u)}<div><b>${esc(u.name)}</b><small>@${esc(u.username)} · ${esc(u.cityName)}</small></div></div>`).join('') || '<p class="muted small">No friends yet — add some below.</p>'}</div>
      ${fr.outgoing.length ? `<p class="muted small">Pending: ${fr.outgoing.map(u => esc(u.name)).join(', ')}</p>` : ''}
      <h4>People you may know</h4>
      <div class="people">${fr.suggestions.map(u => `<div class="person">${avatar(u)}<div><b>${esc(u.name)}</b><small>${esc(u.cityName)}${u.mutual ? ` · ${u.mutual} mutual` : ''}</small></div><button class="btn small ghost" data-add="${u.id}">＋ Add</button></div>`).join('')}</div>
      ${state.meta.demo ? '<p class="fine">Demo people accept requests instantly, so you can try group plans right away.</p>' : ''}
    </aside>
  </div>`;
  const refresh = () => friends(el);
  const add = async id => { try { const r = await api('/friends/request', { method: 'POST', body: { userId: id } }); toast(r.message || (r.status === 'friends' ? 'You are now friends' : 'Request sent')); refresh(); } catch (e) { toast(e.message, 'error'); } };
  $('.social-layout', el).addEventListener('click', async e => {
    const a = e.target.closest('[data-add]'); if (a) { a.disabled = true; add(a.dataset.add); }
    const acc = e.target.closest('[data-accept]'); if (acc) { await api('/friends/respond', { method: 'POST', body: { userId: acc.dataset.accept, accept: true } }); refresh(); }
    const dec = e.target.closest('[data-decline]'); if (dec) { await api('/friends/respond', { method: 'POST', body: { userId: dec.dataset.decline, accept: false } }); refresh(); }
  });
  $('#user-q').oninput = debounce(async ev => {
    const q = ev.target.value.trim();
    if (q.length < 2) { $('#user-results').innerHTML = ''; return; }
    const { items } = await api('/users/search?q=' + encodeURIComponent(q));
    $('#user-results').innerHTML = items.length ? items.map(u => `<div class="person">${avatar(u)}<div><b>${esc(u.name)}</b><small>@${esc(u.username)} · ${esc(u.cityName)}</small></div>${u.isFriend ? '<span class="muted small">Friends</span>' : `<button class="btn small ghost" data-add="${u.id}">＋ Add</button>`}</div>`).join('') : '<p class="muted small">No one found.</p>';
  });
  $('#new-plan').onclick = () => {
    modal(`<div class="pad-l"><p class="eyebrow">NEW GROUP PLAN</p><h2>Who's in?</h2>
      <form id="ng" class="stack"><input name="name" placeholder="e.g. Friday night squad" required maxlength="50">
      ${fr.friends.length ? `<div class="pick-friends">${fr.friends.map(f => `<label class="friend-pick"><input type="checkbox" name="m" value="${f.id}">${avatar(f, 'sm')}<span>${esc(f.name)}<small>${esc(f.cityName)}</small></span></label>`).join('')}</div>` : '<p class="muted">Add friends to invite them, or share the invite link after creating.</p>'}
      <button class="btn primary big">Create plan</button></form></div>`);
    $('#ng').onsubmit = async ev => { ev.preventDefault(); const fd = new FormData(ev.target); const { group } = await api('/groups', { method: 'POST', body: { name: fd.get('name'), memberIds: fd.getAll('m'), city: state.city } }); closeModal(); go('#/group/' + group.id); };
  };
}

export async function group(el, id) {
  if (!requireAuth()) { el.innerHTML = ''; return; }
  loading(el);
  let g;
  try { ({ group: g } = await api('/groups/' + id)); } catch (e) { return errorBox(el, e); }
  const me = state.user.id;
  let lastMsgCount = g.messages.length;
  const inviteUrl = `${location.origin}/#/join/${g.inviteCode}`;
  const renderAll = () => {
    const isOwner = g.ownerId === me;
    const top = g.candidates[0];
    el.innerHTML = `
    <nav class="crumbs"><a href="#/friends">Friends & plans</a> / <span>${esc(g.name)}</span></nav>
    <div class="group-head">
      <div><p class="eyebrow">GROUP PLAN · ${esc(city(g.city).short.toUpperCase())}</p><h1>${esc(g.name)}</h1>
        <div class="avatars">${g.members.map(m => avatar(m, 'sm')).join('')}<span>${g.members.map(m => esc(m.name.split(' ')[0])).join(', ')}</span></div></div>
      <div class="group-tools"><button class="btn ghost" id="invite">⧉ Copy invite link</button><button class="btn ghost" id="add-member">＋ Add friend</button></div>
    </div>
    ${g.finalEventId ? (() => { const f = g.candidates.find(c => c.id === g.finalEventId); return f ? `<div class="final-banner"><div><p class="eyebrow">🎉 LOCKED IN</p><h2>${esc(f.title)}</h2><p>${relDay(f.start)} · ${fmtTime(f.start)} · ${esc(f.venue)}, ${esc(f.area)}</p></div><a class="btn primary big" href="#/event/${f.id}">Book my ticket →</a></div>` : ''; })() : ''}
    <div class="group-layout">
      <section>
        <div class="section-head"><h2>Options <span class="muted small">(${g.candidates.length}) · vote for what you'd go to</span></h2></div>
        <form id="add-opt" class="add-opt"><label class="search small"><span>⌕</span><input id="opt-q" placeholder="Add an event: search comedy, bhajan, hackathon…" autocomplete="off"></label><div id="opt-results" class="opt-results"></div></form>
        <div class="options">${g.candidates.map(c => `<div class="option ${c.id === g.finalEventId ? 'final' : ''}">
          <a href="#/event/${c.id}" class="opt-poster">${poster(c, 'tiny')}</a>
          <div class="opt-main"><a href="#/event/${c.id}"><b>${esc(c.title)}</b></a><small>${relDay(c.start)} · ${fmtTime(c.start)} · ${esc(c.area)} · ${priceLabel(c)}</small>
            <div class="voters">${c.voters.map(v => avatar(v, 'xs')).join('')}<span>${c.votes} vote${c.votes === 1 ? '' : 's'}${c === top && c.votes > 1 ? ' · leading' : ''}</span></div>
            <div class="vote-bar"><i style="width:${Math.round(100 * c.votes / Math.max(1, g.members.length))}%"></i></div></div>
          <div class="opt-actions"><button class="btn small ${c.myVote ? 'primary' : 'ghost'}" data-vote="${c.id}">${c.myVote ? '✓ Voted' : 'Vote'}</button>${isOwner && !g.finalEventId ? `<button class="btn small dark" data-final="${c.id}">Lock it in</button>` : ''}</div>
        </div>`).join('') || '<div class="empty small"><p>No options yet — search above to add events.</p></div>'}</div>
      </section>
      <aside class="chat">
        <h3>Chat</h3>
        <div class="msgs" id="msgs">${g.messages.map(m => `<div class="msg ${m.userId === me ? 'mine' : ''} ${m.system ? 'sys' : ''}">${m.userId !== me && !m.system ? avatar(m.user, 'xs') : ''}<div><small>${m.userId === me ? 'You' : esc(m.user?.name.split(' ')[0] || '')} · ${timeAgo(m.at)}</small><p>${esc(m.text)}</p></div></div>`).join('') || '<p class="muted small">Say hi 👋</p>'}</div>
        <form id="chat-form"><input id="chat-in" placeholder="Message the group…" autocomplete="off" maxlength="500"><button class="btn primary">Send</button></form>
      </aside>
    </div>`;
    const msgs = $('#msgs'); msgs.scrollTop = msgs.scrollHeight;
    $('#invite').onclick = async () => { try { await navigator.clipboard.writeText(inviteUrl); toast('Invite link copied — share it on WhatsApp'); } catch { modal(`<div class="pad-l"><h3>Invite link</h3><input value="${esc(inviteUrl)}" readonly onclick="this.select()"></div>`); } };
    $('#add-member').onclick = async () => {
      const fr = await api('/friends');
      const avail = fr.friends.filter(f => !g.members.some(m => m.id === f.id));
      modal(`<div class="pad-l"><h2>Add friends</h2>${avail.length ? `<div class="people">${avail.map(f => `<div class="person">${avatar(f)}<div><b>${esc(f.name)}</b><small>${esc(f.cityName)}</small></div><button class="btn small primary" data-m="${f.id}">Add</button></div>`).join('')}</div>` : '<p class="muted">All your friends are already here. Share the invite link for others.</p>'}</div>`);
      $$('[data-m]').forEach(b => b.onclick = async () => { ({ group: g } = await api(`/groups/${g.id}/members`, { method: 'POST', body: { userId: b.dataset.m } })); b.textContent = 'Added ✓'; b.disabled = true; renderAll(); });
    };
    $$('[data-vote]').forEach(b => b.onclick = async () => { ({ group: g } = await api(`/groups/${g.id}/vote`, { method: 'POST', body: { eventId: b.dataset.vote } })); renderAll(); });
    $$('[data-final]').forEach(b => b.onclick = async () => { ({ group: g } = await api(`/groups/${g.id}/finalize`, { method: 'POST', body: { eventId: b.dataset.final } })); toast('Locked in! Everyone can book now 🎉'); renderAll(); });
    $('#chat-form').onsubmit = async ev => { ev.preventDefault(); const t = $('#chat-in').value.trim(); if (!t) return; ({ group: g } = await api(`/groups/${g.id}/messages`, { method: 'POST', body: { text: t } })); lastMsgCount = g.messages.length; renderAll(); $('#chat-in').focus(); };
    $('#add-opt').onsubmit = e => e.preventDefault();
    $('#opt-q').oninput = debounce(async ev => {
      const q = ev.target.value.trim(); const box = $('#opt-results');
      if (q.length < 2) { box.innerHTML = ''; return; }
      const { items } = await api(`/events?city=${g.city}&q=${encodeURIComponent(q)}&sort=date&limit=6`);
      box.innerHTML = items.map(e => `<button type="button" class="opt-hit" data-addopt="${e.id}"><b>${esc(e.title)}</b><small>${relDay(e.start)} · ${fmtTime(e.start)} · ${esc(e.area)}</small><em>＋ Add</em></button>`).join('') || '<p class="muted small pad">No matches</p>';
      $$('[data-addopt]', box).forEach(b => b.onclick = async () => { ({ group: g } = await api(`/groups/${g.id}/candidates`, { method: 'POST', body: { eventId: b.dataset.addopt } })); toast('Added — friends can vote now'); renderAll(); });
    }, 300);
  };
  renderAll();
  // light polling so votes & chat from others show up
  const poll = setInterval(async () => {
    if (document.activeElement && ['chat-in', 'opt-q'].includes(document.activeElement.id) && document.activeElement.value) return;
    try { const { group: fresh } = await api('/groups/' + id); if (JSON.stringify(fresh.candidates.map(c => c.votes)) !== JSON.stringify(g.candidates.map(c => c.votes)) || fresh.messages.length !== lastMsgCount) { g = fresh; lastMsgCount = g.messages.length; renderAll(); } } catch {}
  }, 3000);
  return () => clearInterval(poll);
}

export async function join(el, code) {
  if (!requireAuth('Log in to join this plan')) { el.innerHTML = `<div class="empty"><h3>You've been invited to a plan ✳</h3><p>Log in or sign up to join.</p></div>`; return; }
  try { const { group } = await api('/groups/join', { method: 'POST', body: { code } }); toast(`Joined ${group.name}`); go('#/group/' + group.id); }
  catch (e) { errorBox(el, e); }
}
