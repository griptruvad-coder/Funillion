import { state, api, $, $$, esc, money, avatar, requireAuth, toast, go, loading, errorBox, modal, closeModal, timeAgo } from '../core.js';

export async function list(el) {
  loading(el);
  let items;
  try { ({ items } = await api('/communities')); } catch (e) { return errorBox(el, e); }
  el.innerHTML = `
    <div class="section-head"><div><p class="eyebrow">COMMUNITIES</p><h1>Find your people</h1></div>${state.user ? `<button class="btn primary" id="new-community">＋ Create community</button>` : ''}</div>
    <p class="muted">Persistent groups around a shared interest — the point is turning the group chat into a real-world plan.</p>
    ${items.length ? `<div class="community-grid">${items.map(communityCard).join('')}</div>` : `<div class="empty"><h3>No communities yet</h3><p>Be the first to start one.</p></div>`}`;
  $('#new-community')?.addEventListener('click', openCreateCommunity);
}

function communityCard(c) {
  return `<a class="community-card" href="#/communities/${c.id}">
    <div class="community-head"><span class="community-icon">${esc(c.icon || '✳')}</span><div><b style="font:600 17px var(--head)">${esc(c.name)}</b><small class="muted">${c.memberCount} member${c.memberCount === 1 ? '' : 's'}</small></div></div>
    <p class="small muted">${esc(c.description || '')}</p>
    ${c.joined ? '<span class="tag">Joined</span>' : ''}
  </a>`;
}

function openCreateCommunity() {
  const cats = state.meta.interests || state.meta.categories;
  modal(`<div class="pad-l"><p class="eyebrow">NEW COMMUNITY</p><h2>Start a community</h2>
    <form id="cc" class="stack">
      <label>Name<input name="name" maxlength="60" placeholder="e.g. NSUT AI Club" required></label>
      <label>Description<textarea name="description" rows="2" maxlength="300" placeholder="What's this community about?"></textarea></label>
      <fieldset><legend>Interests</legend><div class="chips wrap">${cats.map(k => `<button type="button" class="chip" data-int="${k.id}">${k.icon} ${esc(k.label)}</button>`).join('')}</div></fieldset>
      <button class="btn primary big">Create community</button>
    </form></div>`, { wide: true });
  const picked = new Set();
  $$('[data-int]').forEach(b => b.onclick = () => { const i = b.dataset.int; picked.has(i) ? picked.delete(i) : picked.add(i); b.classList.toggle('selected'); });
  $('#cc').onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { const { community } = await api('/communities', { method: 'POST', body: { ...fd, interestTags: [...picked] } }); closeModal(); go('#/communities/' + community.id); }
    catch (err) { toast(err.message, 'error'); }
  };
}

export async function detail(el, id) {
  loading(el);
  let c, plans;
  try { ({ community: c } = await api('/communities/' + id)); ({ items: plans } = await api(`/communities/${id}/plans`)); } catch (e) { return errorBox(el, e); }
  let messages = c.isMember ? (await api(`/communities/${id}/messages`).catch(() => ({ items: [] }))).items : [];

  function renderAll() {
    el.innerHTML = `
    <nav class="crumbs"><a href="#/communities">Communities</a> / <span>${esc(c.name)}</span></nav>
    <div class="plan-detail-head">
      <div class="community-head"><span class="community-icon" style="font-size:32px;width:60px;height:60px">${esc(c.icon || '✳')}</span>
        <div><p class="eyebrow">${c.memberCount} MEMBER${c.memberCount === 1 ? '' : 'S'}${c.visibility === 'private' ? ' · PRIVATE' : ''}</p><h1>${esc(c.name)}</h1></div></div>
      <div class="group-tools">
        ${!c.isMember ? `<button class="btn primary" id="join-c">Join</button>` : `<button class="btn ghost" id="leave-c">Leave</button>`}
        ${c.isMember ? `<button class="btn dark" id="cta-plan">✦ Create plan for community</button>` : ''}
      </div>
    </div>
    <p class="muted">${esc(c.description || '')}</p>
    ${c.interestTags.length ? `<div class="chips wrap small">${c.interestTags.map(t => `<span class="chip static">${esc((state.meta.interests || []).find(i => i.id === t)?.label || t)}</span>`).join('')}</div>` : ''}
    <div class="plan-detail-layout">
      <section>
        <div class="section-head"><h2>Plans <span class="muted small">(${plans.length})</span></h2></div>
        ${plans.length ? `<div class="plan-list">${plans.map(p => `<a class="plan-item" href="#/plans/${p.id}"><div class="plan-item-top"><b>${esc(p.title)}</b><span class="status-pill ${p.status}">${p.status}</span></div><div class="avatars">${p.participants.slice(0, 5).map(u => avatar(u, 'sm')).join('')}<span>${p.acceptedCount}/${p.maxParticipants}</span></div></a>`).join('')}</div>` : `<div class="empty small"><p>No plans yet — be the first to start one.</p></div>`}
        <div class="section-head" style="margin-top:34px"><h2>Posts</h2></div>
        ${c.isMember ? `<form id="post-form" class="stack" style="margin-bottom:14px"><textarea name="text" rows="2" maxlength="500" placeholder="Share something with the community…" required></textarea><button class="btn primary" style="align-self:flex-start">Post</button></form>` : ''}
        ${c.posts.length ? c.posts.map(p => `<div class="post ${p.kind}"><div class="post-head">${avatar(p.author, 'xs')}<b>${esc(p.author?.name || 'Someone')}</b><span>· ${timeAgo(p.createdAt)}</span>${p.kind === 'announcement' ? '<span class="tag">Announcement</span>' : ''}</div><p>${esc(p.text)}</p></div>`).join('') : `<p class="muted small">No posts yet.</p>`}
      </section>
      <aside>
        <div class="friends-col" style="margin-bottom:16px">
          <p class="eyebrow">MEMBERS (${c.members.length})</p>
          <div class="people">${c.members.slice(0, 20).map(m => `<div class="person">${avatar(m)}<div><b>${esc(m.name)}</b><small>${m.role !== 'member' ? m.role : `@${esc(m.username)}`}</small></div></div>`).join('')}</div>
        </div>
        ${c.isMember ? `<div class="chat" style="height:420px"><h3>Chat</h3><div class="msgs" id="msgs">${messages.map(m => `<div class="msg ${m.userId === state.user?.id ? 'mine' : ''} ${m.system ? 'sys' : ''}">${m.userId !== state.user?.id && !m.system ? avatar(m.user, 'xs') : ''}<div><small>${m.userId === state.user?.id ? 'You' : esc(m.user?.name?.split(' ')[0] || '')} · ${timeAgo(m.at)}</small><p>${esc(m.text)}</p></div></div>`).join('') || '<p class="muted small">Say hi 👋</p>'}</div><form id="chat-form"><input id="chat-in" placeholder="Message the community…" maxlength="500" autocomplete="off"><button class="btn primary">Send</button></form></div>` : ''}
      </aside>
    </div>`;
    const msgs = $('#msgs'); if (msgs) msgs.scrollTop = msgs.scrollHeight;
    wire();
  }

  function wire() {
    $('#join-c')?.addEventListener('click', async () => { if (!requireAuth('Log in to join')) return; try { await api(`/communities/${id}/join`, { method: 'POST' }); toast(`Joined ${c.name}`); ({ community: c } = await api('/communities/' + id)); renderAll(); } catch (e) { toast(e.message, 'error'); } });
    $('#leave-c')?.addEventListener('click', async () => { if (!confirm(`Leave ${c.name}?`)) return; await api(`/communities/${id}/leave`, { method: 'POST' }); toast('Left community'); ({ community: c } = await api('/communities/' + id)); renderAll(); });
    $('#cta-plan')?.addEventListener('click', () => openCreatePlanForCommunity(c, () => api(`/communities/${id}/plans`).then(r => { plans = r.items; renderAll(); })));
    $('#post-form')?.addEventListener('submit', async e => { e.preventDefault(); const fd = new FormData(e.target); try { await api(`/communities/${id}/posts`, { method: 'POST', body: { text: fd.get('text') } }); ({ community: c } = await api('/communities/' + id)); renderAll(); } catch (err) { toast(err.message, 'error'); } });
    $('#chat-form')?.addEventListener('submit', async e => { e.preventDefault(); const t = $('#chat-in').value.trim(); if (!t) return; try { const { message } = await api(`/communities/${id}/messages`, { method: 'POST', body: { text: t } }); messages = [...messages, message]; renderAll(); $('#chat-in').focus(); } catch (err) { toast(err.message, 'error'); } });
  }
  renderAll();
}

function openCreatePlanForCommunity(c, onCreated) {
  modal(`<div class="pad-l"><p class="eyebrow">${esc(c.name.toUpperCase())}</p><h2>Create a plan for this community</h2>
    <p class="muted small">e.g. “Anyone from ${esc(c.name)} interested in a hackathon meetup Saturday?”</p>
    <form id="cpc" class="stack"><textarea name="text" rows="2" maxlength="400" placeholder="What do you want to do?" required></textarea><button class="btn primary big">Create plan</button></form></div>`);
  $('#cpc').onsubmit = async e => {
    e.preventDefault();
    const text = new FormData(e.target).get('text');
    try { const { plan } = await api('/plans', { method: 'POST', body: { text, communityId: c.id } }); closeModal(); toast('Plan created — members can vote and join'); go('#/plans/' + plan.id); onCreated?.(); }
    catch (err) { toast(err.message, 'error'); }
  };
}
