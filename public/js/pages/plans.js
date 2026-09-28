import { state, api, $, $$, esc, money, avatar, requireAuth, toast, go, loading, errorBox, modal, closeModal, timeAgo } from '../core.js';

const TZ = { timeZone: 'Asia/Kolkata' };
const fmtWhen = iso => new Date(iso).toLocaleString('en-IN', { ...TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmtRange = (a, b) => `${new Date(a).toLocaleDateString('en-IN', { ...TZ, weekday: 'short', day: 'numeric', month: 'short' })} · ${new Date(a).toLocaleTimeString('en-IN', { ...TZ, hour: 'numeric', minute: '2-digit' })}–${new Date(b).toLocaleTimeString('en-IN', { ...TZ, hour: 'numeric', minute: '2-digit' })}`;

export async function list(el) {
  if (!requireAuth('Log in to see your plans')) { el.innerHTML = `<div class="empty"><h3>Your plans live here</h3><p>Tell Funillion what you want to do, and the people who join show up here.</p></div>`; return; }
  loading(el);
  let items;
  try { ({ items } = await api('/plans')); } catch (e) { return errorBox(el, e); }
  el.innerHTML = `
    <div class="section-head"><div><p class="eyebrow">PLANS</p><h1>Your plans</h1></div><a class="btn primary" href="#/create">＋ New plan</a></div>
    ${items.length ? `<div class="plan-list">${items.map(planItemCard).join('')}</div>`
      : `<div class="empty"><h3>No plans yet</h3><p>Describe what you want to do, or tap I'm Free, and Funillion finds the people.</p><a class="btn primary" href="#/create">Create a plan</a></div>`}
    <p class="muted small" style="margin-top:28px">Looking for the older event-group plans (vote on an event with friends)? <a class="link" href="#/friends">Open Friends & event groups →</a></p>`;
}

function planItemCard(p) {
  return `<a class="plan-item" href="#/plans/${p.id}">
    <div class="plan-item-top"><b>${esc(p.title)}</b><span class="status-pill ${p.status}">${p.status}</span></div>
    <div class="plan-facts small"><span>🕐 ${fmtWhen(p.startTime)}</span>${p.budgetPerPerson != null ? `<span>${money(p.budgetPerPerson)}/pp</span>` : ''}</div>
    <div class="avatars">${p.participants.slice(0, 5).map(u => avatar(u, 'sm')).join('')}<span>${p.acceptedCount}/${p.maxParticipants} people</span></div>
  </a>`;
}

export async function detail(el, id) {
  if (!requireAuth()) { el.innerHTML = ''; return; }
  loading(el);
  let data;
  try { data = await api('/plans/' + id); } catch (e) { return errorBox(el, e); }
  let p = data.plan, messages = data.messages;
  const me = state.user.id;

  function renderAll() {
    const myRow = p.participants.find(x => x.id === me);
    const canChat = myRow && myRow.status === 'accepted';
    const open = ['DRAFT', 'MATCHING', 'INVITING'].includes(p.status);
    el.innerHTML = `
    <nav class="crumbs"><a href="#/plans">Plans</a> / <span>${esc(p.title)}</span></nav>
    <div class="plan-detail-head">
      <div><p class="eyebrow">${esc((p.activityType || 'PLAN').toUpperCase())} · <span class="status-pill ${p.status}">${p.status}</span></p><h1>${esc(p.title)}</h1>
        <div class="plan-facts"><span>🕐 ${fmtRange(p.startTime, p.endTime)}</span>${p.budgetPerPerson != null ? `<span>💰 ${money(p.budgetPerPerson)}/person</span>` : ''}<span>⌖ within ${p.radiusKm} km</span><span>◎ ${p.acceptedCount}/${p.maxParticipants} people</span></div></div>
      <div class="group-tools">
        ${p.myStatus === 'invited' ? `<button class="btn primary" id="accept">Accept</button><button class="btn ghost" id="decline">Decline</button>` : ''}
        ${!myRow && (open || p.status === 'CONFIRMED') ? `<button class="btn primary" id="join-plan">Join</button>` : ''}
        ${p.isCreator && open ? `<button class="btn dark" id="finalize">Finalize now</button>` : ''}
        ${p.isCreator && !['CANCELLED', 'COMPLETED'].includes(p.status) ? `<button class="btn danger" id="cancel-plan">Cancel</button>` : ''}
        ${myRow && myRow.status === 'accepted' && !p.isCreator ? `<button class="btn ghost" id="leave-plan">Leave</button>` : ''}
      </div>
    </div>
    ${p.description ? `<p class="muted">“${esc(p.description)}”</p>` : ''}
    <div class="plan-detail-layout">
      <section>
        ${p.timeOptions.length ? `<div class="section"><h2>Vote on a time</h2>${p.timeOptions.map(o => `<div class="time-opt"><span>${fmtRange(o.start, o.end)} · ${o.votes} vote${o.votes === 1 ? '' : 's'}</span><button class="btn small ${o.myVote ? 'primary' : 'ghost'}" data-vote="${o.id}">${o.myVote ? '✓ Voted' : 'Vote'}</button></div>`).join('')}</div>` : ''}
        <div class="section-head"><h2>Who's in <span class="muted small">(${p.participants.length})</span></h2></div>
        ${p.participants.map(u => participantRow(u, me)).join('')}
      </section>
      <aside class="chat">
        <h3>Chat</h3>
        <div class="msgs" id="msgs">${messages.map(m => msgHtml(m, me)).join('') || '<p class="muted small">Say hi 👋</p>'}</div>
        ${canChat ? `<form id="chat-form"><input id="chat-in" placeholder="Message the plan…" maxlength="500" autocomplete="off"><button class="btn primary">Send</button></form>` : `<p class="muted small">${p.myStatus === 'invited' ? 'Accept the invite to chat.' : 'Join the plan to chat.'}</p>`}
      </aside>
    </div>`;
    const msgs = $('#msgs'); if (msgs) msgs.scrollTop = msgs.scrollHeight;
    wire();
  }

  async function act(fn) { try { await fn(); } catch (e) { toast(e.message, 'error'); } }

  function wire() {
    $('#accept')?.addEventListener('click', () => act(async () => { ({ plan: p } = await api(`/plans/${p.id}/respond`, { method: 'POST', body: { accept: true } })); toast('You\'re in 🎉'); renderAll(); }));
    $('#decline')?.addEventListener('click', () => act(async () => { ({ plan: p } = await api(`/plans/${p.id}/respond`, { method: 'POST', body: { accept: false } })); toast('Declined'); renderAll(); }));
    $('#join-plan')?.addEventListener('click', () => act(async () => { ({ plan: p } = await api(`/plans/${p.id}/join`, { method: 'POST' })); toast('Joined the plan'); renderAll(); }));
    $('#finalize')?.addEventListener('click', () => act(async () => { ({ plan: p } = await api(`/plans/${p.id}/finalize`, { method: 'POST' })); toast('Plan confirmed 🎉'); renderAll(); }));
    $('#cancel-plan')?.addEventListener('click', () => { if (!confirm('Cancel this plan for everyone?')) return; act(async () => { ({ plan: p } = await api(`/plans/${p.id}/cancel`, { method: 'POST' })); toast('Plan cancelled'); renderAll(); }); });
    $('#leave-plan')?.addEventListener('click', () => act(async () => { await api(`/plans/${p.id}/leave`, { method: 'POST' }); toast('You left the plan'); go('#/plans'); }));
    $$('[data-vote]').forEach(b => b.onclick = () => act(async () => { ({ plan: p } = await api(`/plans/${p.id}/time-options/${b.dataset.vote}/vote`, { method: 'POST' })); renderAll(); }));
    $$('[data-report]').forEach(b => b.onclick = () => openSafetyMenu(b.dataset.report, b.dataset.name));
    $('#chat-form')?.addEventListener('submit', ev => { ev.preventDefault(); act(async () => { const t = $('#chat-in').value.trim(); if (!t) return; const { message } = await api(`/plans/${p.id}/messages`, { method: 'POST', body: { text: t } }); messages = [...messages, message]; renderAll(); $('#chat-in').focus(); }); });
  }

  renderAll();
  const poll = setInterval(async () => {
    if (document.activeElement?.id === 'chat-in' && document.activeElement.value) return;
    try {
      const fresh = await api('/plans/' + id);
      if (fresh.plan.status !== p.status || fresh.messages.length !== messages.length || fresh.plan.acceptedCount !== p.acceptedCount) { p = fresh.plan; messages = fresh.messages; renderAll(); }
    } catch {}
  }, 4000);
  return () => clearInterval(poll);
}

function participantRow(u, meId) {
  const pct = Math.round((u.compatibilityScore || 0) * 100);
  const sub = [u.role === 'creator' ? 'Organiser' : null, u.status !== 'accepted' ? u.status : null, ...(u.reasons || [])].filter(Boolean).join(' · ');
  return `<div class="participant-row">
    ${avatar(u)}
    <div><b>${esc(u.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    ${u.id !== meId ? `<span class="compat" style="--s:${pct}" title="Compatibility">${pct}%</span><button class="btn small ghost" data-report="${u.id}" data-name="${esc(u.name)}" aria-label="Report or block ${esc(u.name)}">⋯</button>` : ''}
  </div>`;
}

function msgHtml(m, me) {
  return `<div class="msg ${m.userId === me ? 'mine' : ''} ${m.system ? 'sys' : ''}">${m.userId !== me && !m.system ? avatar(m.user, 'xs') : ''}<div><small>${m.userId === me ? 'You' : esc(m.user?.name?.split(' ')[0] || '')} · ${timeAgo(m.at)}</small><p>${esc(m.text)}</p></div></div>`;
}

function openSafetyMenu(userId, name) {
  modal(`<div class="pad-l"><p class="eyebrow">${esc(name.toUpperCase())}</p><h2>Report or block</h2>
    <div class="stack">
      <button class="btn ghost full" id="s-report">Report this person</button>
      <button class="btn danger full" id="s-block">Block this person</button>
    </div></div>`);
  $('#s-report').onclick = () => {
    modal(`<div class="pad-l"><h2>Report ${esc(name)}</h2>
      <form id="report-form" class="stack">
        <label>Reason<select name="reason"><option value="spam">Spam</option><option value="harassment">Harassment</option><option value="fake_profile">Fake profile</option><option value="inappropriate_content">Inappropriate content</option><option value="no_show">No-show</option><option value="safety_concern">Safety concern</option><option value="other">Other</option></select></label>
        <label>Details (optional)<textarea name="note" rows="3" maxlength="500"></textarea></label>
        <button class="btn primary big">Submit report</button>
      </form></div>`);
    $('#report-form').onsubmit = async e => { e.preventDefault(); const fd = Object.fromEntries(new FormData(e.target)); await api('/reports', { method: 'POST', body: { targetType: 'user', targetId: userId, reason: fd.reason, note: fd.note } }); closeModal(); toast('Report submitted — thank you'); };
  };
  $('#s-block').onclick = async () => { if (!confirm(`Block ${name}? They won't be matched or invited to your plans again.`)) return; await api(`/users/${userId}/block`, { method: 'POST' }); closeModal(); toast(`Blocked ${name}`); };
}
