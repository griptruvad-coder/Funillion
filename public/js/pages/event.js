import { state, api, $, $$, esc, money, cat, city, poster, card, avatar, fmtDayLong, fmtTime, relDay, dayKey, requireAuth, toast, go, modal, closeModal, loading, errorBox } from '../core.js';

let map;
export async function render(el, id) {
  loading(el, 'Loading event…');
  let e;
  try { ({ event: e } = await api('/events/' + id)); } catch (err) { return errorBox(el, err); }
  const c = cat(e.category);
  const qty = Object.fromEntries(e.tiers.map(t => [t.id, 0]));
  const past = new Date(e.start) < Date.now() - 30 * 60000;
  const end = new Date(new Date(e.start).getTime() + e.durH * 3600000);
  const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(e.title)}&dates=${iso(e.start)}/${iso(end)}&location=${encodeURIComponent(`${e.venue}, ${e.area}, ${e.cityName}`)}&details=${encodeURIComponent('Found on Funillion')}`;
  el.innerHTML = `
  <nav class="crumbs"><a href="#/discover">Discover</a> / <a href="#/discover?cat=${c.id}">${esc(c.label)}</a> / <span>${esc(e.title)}</span></nav>
  <div class="event-layout">
    <div class="event-main">
      <div class="event-hero">${poster(e, 'big')}</div>
      <div class="event-titles">
        <span class="tag" style="background:${c.color};color:${c.ink}">${c.icon} ${esc(c.label.toUpperCase())}</span> ${e.fill >= 0.85 && !e.soldOut ? '<span class="tag hot">🔥 Almost sold out</span>' : ''} <span class="tag outline">Fun Score ${e.funScore}</span>
        <h1>${esc(e.title)}</h1>
        <p class="muted">by ${esc(e.organizer)}</p>
      </div>
      <div class="facts">
        <div><span>◷</span><div><b>${['Today', 'Tomorrow'].includes(relDay(e.start)) ? relDay(e.start) + ' · ' : ''}${fmtDayLong(e.start)}</b><small>${fmtTime(e.start)} – ${fmtTime(end)}${dayKey(end) !== dayKey(e.start) ? ' (next day)' : ''} · ${e.durH >= 20 ? Math.round(e.durH) + ' hours' : e.durH + (e.durH === 1 ? ' hr' : ' hrs')}</small></div></div>
        <div><span>⌖</span><div><b>${esc(e.venue)}</b><small>${esc(e.area)}, ${esc(e.cityName)} · ${e.kmFromCentre} km from city centre</small></div></div>
        <div><span>₹</span><div><b>${e.priceMin === 0 ? 'Free entry available' : 'From ' + money(e.priceMin)}</b><small>${e.tiers.length} ticket type${e.tiers.length > 1 ? 's' : ''} · instant e-ticket</small></div></div>
      </div>
      ${e.friends.length || e.interestedCount ? `<div class="social-proof">${e.friends.map(f => avatar(f, 'sm')).join('')}<span>${e.friendCount ? `<b>${e.friendCount} friend${e.friendCount > 1 ? 's' : ''}</b> interested` : ''}${e.friendCount && e.interestedCount ? ' · ' : ''}${e.interestedCount ? `${e.interestedCount} people on Funillion interested` : ''}</span></div>` : ''}
      <section class="block"><h2>About</h2><p class="prose">${esc(e.description)}</p><div class="chips wrap small">${(e.tags || []).map(t => `<span class="chip static">#${esc(t)}</span>`).join('')}</div></section>
      <section class="block"><h2>Location</h2><div id="mini-map" class="mini-map"></div><a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}">Open in Google Maps ↗</a></section>
      <section class="block sources-block"><h2>✳ Where this listing comes from</h2>
        <p class="muted">Funillion found this event on ${e.sourceDetails.length} platform${e.sourceDetails.length > 1 ? 's' : ''}${e.sourceDetails.length > 1 ? ' and merged them into one clean listing — same event, no duplicates' : ''}.</p>
        <ul class="source-list">${e.sourceDetails.map(s => `<li><b>${esc(s.name)}</b><span>${esc(s.kind || '')}</span><em>“${esc(s.title)}”${s.priceMin != null ? ` · from ${money(s.priceMin)}` : ''}</em></li>`).join('')}</ul>
      </section>
    </div>
    <aside class="event-side">
      <div class="ticket-box" id="ticket-box">
        <h3>${past ? 'This event has ended' : e.soldOut ? 'Sold out' : 'Get tickets'}</h3>
        ${e.tiers.map(t => `<div class="tier ${t.left ? '' : 'out'}"><div><b>${esc(t.name)}</b><span>${money(t.price)}${t.left <= 15 && t.left ? ` · <em>only ${t.left} left</em>` : ''}${!t.left ? ' · sold out' : ''}</span></div>
          <div class="stepper" data-tier="${t.id}"><button data-d="-1" aria-label="Fewer ${esc(t.name)}" ${past || !t.left ? 'disabled' : ''}>−</button><output>0</output><button data-d="1" aria-label="More ${esc(t.name)}" ${past || !t.left ? 'disabled' : ''}>+</button></div></div>`).join('')}
        <div class="ticket-total"><span>Total</span><b id="total">₹0</b></div>
        <button class="btn primary big full" id="book" disabled>Select tickets</button>
        <p class="fine">Secure checkout · Free cancellation up to 24h before</p>
      </div>
      <div class="action-row">
        <button class="btn ghost ${e.saved ? 'is-saved' : ''}" data-save="${e.id}" data-label="1">${e.saved ? '♥ Saved' : '♡ Save'}</button>
        <button class="btn ghost" id="interested">${e.isInterested ? '★ Interested' : '☆ Interested'}</button>
        <button class="btn ghost" id="share">↗ Share</button>
      </div>
      <button class="btn dark full" id="group-plan">☺ Plan this with friends</button>
      <a class="btn ghost full" target="_blank" rel="noopener" href="${gcal}">＋ Add to Google Calendar</a>
    </aside>
  </div>
  ${e.similar.length ? `<section class="section"><div class="section-head"><div><p class="eyebrow">MORE LIKE THIS</p><h2>Similar in ${esc(city(e.city).short)}</h2></div></div><div class="grid four">${e.similar.map(s => card(s)).join('')}</div></section>` : ''}`;

  // tickets
  const update = () => {
    const total = e.tiers.reduce((s, t) => s + t.price * qty[t.id], 0);
    const count = Object.values(qty).reduce((a, b) => a + b, 0);
    $('#total').textContent = count ? (total ? '₹' + total.toLocaleString('en-IN') : 'Free') : '₹0';
    $('#book').disabled = !count;
    $('#book').textContent = count ? (total ? `Book ${count} ticket${count > 1 ? 's' : ''} · ₹${total.toLocaleString('en-IN')}` : `Register ${count} · Free`) : 'Select tickets';
  };
  $$('.stepper').forEach(s => s.onclick = ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const t = e.tiers.find(t => t.id === s.dataset.tier);
    qty[t.id] = Math.max(0, Math.min(t.left, 10, qty[t.id] + Number(b.dataset.d)));
    $('output', s).textContent = qty[t.id]; update();
  });
  $('#book').onclick = async () => {
    if (!requireAuth('Log in to book tickets')) return;
    $('#book').disabled = true; $('#book').textContent = 'Holding your seats…';
    try {
      const { booking } = await api('/bookings', { method: 'POST', body: { eventId: e.id, items: Object.entries(qty).filter(([, q]) => q).map(([tierId, q]) => ({ tierId, qty: q })) } });
      go('#/checkout/' + booking.id);
    } catch (err) { toast(err.message, 'error'); update(); }
  };
  $('#interested').onclick = async () => {
    if (!requireAuth('Log in so friends can see what you like')) return;
    const { interested } = await api(`/events/${e.id}/interested`, { method: 'POST' });
    $('#interested').textContent = interested ? '★ Interested' : '☆ Interested';
    toast(interested ? 'Marked interested — your friends will see it' : 'Removed');
  };
  $('#share').onclick = async () => {
    const url = location.href;
    try { if (navigator.share) await navigator.share({ title: e.title, url }); else { await navigator.clipboard.writeText(url); toast('Link copied'); } } catch {}
  };
  $('#group-plan').onclick = () => { if (requireAuth('Log in to plan with friends')) addToGroup(e); };

  // map
  if (window.L) {
    map = L.map('mini-map', { scrollWheelZoom: false }).setView([e.lat, e.lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
    L.marker([e.lat, e.lng], { icon: L.divIcon({ className: 'pin', html: `<span style="--pc:${c.color};--pi:${c.ink}"><i>${c.icon}</i></span>`, iconSize: [34, 34], iconAnchor: [17, 34] }) }).addTo(map);
  } else $('#mini-map').innerHTML = '<p class="muted pad">Map needs an internet connection.</p>';
  return () => { map?.remove(); map = null; };
}

const iso = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export async function addToGroup(e) {
  const [{ items: groups }, fr] = await Promise.all([api('/groups'), api('/friends')]);
  modal(`<div class="pad-l"><p class="eyebrow">PLAN WITH FRIENDS</p><h2>Add “${esc(e.title)}” to a plan</h2>
    ${groups.length ? `<h4>Your group plans</h4><div class="list">${groups.map(g => `<button class="list-row" data-g="${g.id}"><b>${esc(g.name)}</b><span>${g.members.length} people · ${g.candidates} options</span><em>Add →</em></button>`).join('')}</div>` : ''}
    <h4>Or start a new one</h4>
    <form id="new-group" class="stack"><input name="name" placeholder="e.g. Saturday night squad" required maxlength="50">
      ${fr.friends.length ? `<div class="pick-friends">${fr.friends.map(f => `<label class="friend-pick"><input type="checkbox" name="m" value="${f.id}">${avatar(f, 'sm')}<span>${esc(f.name)}</span></label>`).join('')}</div>` : '<p class="muted">Add friends first to invite them — you can also share an invite link later.</p>'}
      <button class="btn primary big">Create plan & invite</button></form></div>`);
  $$('[data-g]').forEach(b => b.onclick = async () => { await api(`/groups/${b.dataset.g}/candidates`, { method: 'POST', body: { eventId: e.id } }); closeModal(); toast('Added to the plan — friends can vote now'); go('#/group/' + b.dataset.g); });
  $('#new-group').onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(ev.target);
    const { group } = await api('/groups', { method: 'POST', body: { name: fd.get('name'), memberIds: fd.getAll('m'), eventIds: [e.id], city: e.city } });
    closeModal(); go('#/group/' + group.id);
  };
}
