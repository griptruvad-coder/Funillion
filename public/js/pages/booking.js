import { state, api, $, $$, esc, money, cat, poster, fmtDayLong, fmtTime, fmtDay, relDay, requireAuth, toast, go, loading, errorBox } from '../core.js';

let rzpLoader = null;
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  rzpLoader ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://checkout.razorpay.com/v1/checkout.js';
    sc.onload = resolve; sc.onerror = () => { rzpLoader = null; reject(new Error('Could not load Razorpay — check your internet connection')); };
    document.head.appendChild(sc);
  });
  return rzpLoader;
}

export async function checkout(el, id) {
  if (!requireAuth('Log in to complete your booking')) { el.innerHTML = ''; return; }
  loading(el);
  let b;
  try { ({ booking: b } = await api('/bookings/' + id)); } catch (e) { return errorBox(el, e); }
  if (b.status === 'confirmed') return go('#/ticket/' + b.id);
  if (b.status !== 'pending') { el.innerHTML = `<div class="empty"><h3>This hold has ${b.status === 'expired' ? 'expired' : 'been ' + b.status}</h3><p>Your seats were released so others could book them.</p><a class="btn primary" href="#/event/${b.eventId}">Try again</a></div>`; return; }
  const e = b.event, free = b.total === 0;
  const u = state.user;
  const pay = state.meta.payments || { provider: 'demo' };
  const rzp = pay.provider === 'razorpay';
  const payLabel = free ? 'Confirm free registration' : `Pay ${money(b.total)}`;
  el.innerHTML = `
  <div class="checkout">
    <div class="checkout-main">
      <p class="eyebrow">CHECKOUT</p><h1>Almost there.</h1>
      <div class="hold-timer" id="timer">Seats held for <b>10:00</b></div>
      <form id="pay-form" class="stack">
        <fieldset><legend>Who's going? <small>(tickets are sent here)</small></legend>
          <div class="two"><label>Full name<input name="name" required value="${esc(b.attendee?.name || u.name)}" autocomplete="name"></label>
          <label>Mobile<input name="phone" required inputmode="numeric" placeholder="98765 43210" value="${esc(b.attendee?.phone || '')}" autocomplete="tel"></label></div>
          <label>Email<input name="email" type="email" required value="${esc(b.attendee?.email || u.email || '')}" autocomplete="email"></label>
        </fieldset>
        ${free ? '' : rzp ? `<fieldset><legend>Payment</legend>
          <div class="pay-razorpay"><span style="font-size:26px">⚡</span><div><b>UPI · Cards · Netbanking · Wallets</b><span>Secure payment by Razorpay — you'll choose the method in the next step</span></div></div>
          ${pay.mode === 'test' ? '<p class="test-banner"><b>Test mode</b> — no real money. Use UPI ID <code>success@razorpay</code>, or card <code>4111 1111 1111 1111</code> with any future expiry and any CVV.</p>' : ''}
        </fieldset>` : `<fieldset><legend>Pay with</legend>
          <div class="pay-tabs" role="radiogroup">
            <label class="pay-opt"><input type="radio" name="method" value="upi" checked><span>⚡ UPI</span></label>
            <label class="pay-opt"><input type="radio" name="method" value="card"><span>▭ Card</span></label>
            <label class="pay-opt"><input type="radio" name="method" value="netbanking"><span>⌂ Netbanking</span></label>
          </div>
          <div class="pay-panel" data-panel="upi"><label>UPI ID<input name="upiId" placeholder="yourname@okhdfcbank" autocomplete="off"></label><p class="fine">You'd approve the request in your UPI app.</p></div>
          <div class="pay-panel" data-panel="card" hidden><label>Card number<input name="cardNumber" inputmode="numeric" placeholder="4111 1111 1111 1111" autocomplete="cc-number"></label><div class="two"><label>Expiry<input name="exp" placeholder="MM/YY" autocomplete="cc-exp"></label><label>CVV<input name="cvv" inputmode="numeric" maxlength="4" placeholder="•••" autocomplete="cc-csc"></label></div></div>
          <div class="pay-panel" data-panel="netbanking" hidden><label>Bank<select name="bank"><option>HDFC Bank</option><option>ICICI Bank</option><option>State Bank of India</option><option>Axis Bank</option><option>Kotak Mahindra Bank</option></select></label></div>
        </fieldset>`}
        <p class="form-error" hidden></p>
        <button class="btn primary big full" id="pay">${payLabel}</button>
        ${!free && !rzp ? '<p class="demo-banner">Demo checkout — no real money moves. Add Razorpay keys on the server for real payments.</p>' : ''}
      </form>
    </div>
    <aside class="summary">
      ${poster(e, 'short')}
      <h3>${esc(e.title)}</h3>
      <p class="muted">${fmtDayLong(e.start)} · ${fmtTime(e.start)}<br>${esc(e.venue)}, ${esc(e.area)}</p>
      <div class="lines">${b.items.map(i => `<div><span>${i.qty} × ${esc(i.name)}</span><b>${money(i.price * i.qty)}</b></div>`).join('')}
        <div><span>Booking fee</span><b>${money(b.fee)}</b></div><div class="grand"><span>Total</span><b>${money(b.total)}</b></div></div>
      <a class="link" href="#/event/${e.id}" id="change">← Change tickets</a>
    </aside>
  </div>`;
  let expires = new Date(b.expiresAt).getTime();
  const tick = () => {
    const left = Math.max(0, expires - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
    $('#timer').innerHTML = left ? `Seats held for <b>${m}:${String(s).padStart(2, '0')}</b>` : '<b>Hold expired</b> — seats released';
    $('#timer').classList.toggle('urgent', left < 120000);
    if (!left) { clearInterval(timer); $('#pay').disabled = true; }
  };
  const timer = setInterval(tick, 1000); tick();
  $$('input[name=method]').forEach(r => r.onchange = () => $$('.pay-panel').forEach(p => p.hidden = p.dataset.panel !== r.value));
  $('#change').onclick = () => api(`/bookings/${b.id}/cancel`, { method: 'POST' }).catch(() => {});
  const btn = $('#pay');
  const showError = msg => { const p = $('.form-error'); p.textContent = msg; p.hidden = !msg; };
  const reset = () => { btn.disabled = false; btn.textContent = payLabel; };
  const done = booking => { clearInterval(timer); toast('Booked! Your tickets are ready 🎉'); go('#/ticket/' + booking.id); };

  $('#pay-form').onsubmit = async ev => {
    ev.preventDefault();
    showError('');
    const fd = Object.fromEntries(new FormData(ev.target));
    const attendee = { name: fd.name, email: fd.email, phone: fd.phone };
    btn.disabled = true; btn.textContent = free ? 'Confirming…' : rzp ? 'Opening secure payment…' : 'Processing payment…';
    try {
      if (free || !rzp) {
        const { booking } = await api(`/bookings/${b.id}/pay`, { method: 'POST', body: { method: free ? 'free' : fd.method, upiId: fd.upiId, cardNumber: fd.cardNumber, attendee } });
        return done(booking);
      }
      // Razorpay: 1) server creates the order  2) Checkout collects payment  3) server verifies the signature
      const order = await api(`/bookings/${b.id}/order`, { method: 'POST', body: { attendee } });
      if (order.expiresAt) expires = new Date(order.expiresAt).getTime();
      await loadRazorpay();
      const checkoutWidget = new window.Razorpay({
        key: order.keyId, order_id: order.orderId, amount: order.amount, currency: order.currency,
        name: order.name, description: order.description, prefill: order.prefill, notes: order.notes,
        theme: { color: '#181a17' },
        handler: async resp => {
          btn.disabled = true; btn.textContent = 'Confirming your tickets…';
          try { const { booking } = await api(`/bookings/${b.id}/pay`, { method: 'POST', body: resp }); done(booking); }
          catch (err) { showError(err.message); reset(); }
        },
        modal: { ondismiss: () => { reset(); showError('Payment window closed — your seats are still held. Try again when ready.'); } },
      });
      checkoutWidget.on('payment.failed', r => { showError(`Payment failed: ${r.error?.description || 'please try another method'}`); reset(); });
      checkoutWidget.open();
    } catch (err) { showError(err.message); reset(); }
  };
  return () => clearInterval(timer);
}

export async function ticket(el, id) {
  if (!requireAuth()) { el.innerHTML = ''; return; }
  loading(el);
  let b;
  try { ({ booking: b } = await api('/bookings/' + id)); } catch (e) { return errorBox(el, e); }
  const e = b.event, c = cat(e.category);
  const hoursLeft = (new Date(e.start) - Date.now()) / 3600000;
  const end = new Date(new Date(e.start).getTime() + e.durH * 3600000);
  const f = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  el.innerHTML = `
  <div class="ticket-page">
    ${b.status === 'confirmed' ? `<p class="eyebrow">YOU'RE GOING 🎉</p><h1>See you at ${esc(e.title)}!</h1>` : `<p class="eyebrow">BOOKING ${esc(b.status.toUpperCase())}</p><h1>${esc(e.title)}</h1>`}
    <div class="ticket-stub ${b.status}">
      <div class="stub-left" style="--pc:${c.color};--pi:${c.ink}">
        <span class="stub-cat">${c.icon} ${esc(c.label.toUpperCase())}</span>
        <h2>${esc(e.title)}</h2>
        <div class="stub-grid">
          <div><small>DATE</small><b>${fmtDay(e.start)}</b></div><div><small>TIME</small><b>${fmtTime(e.start)}</b></div>
          <div><small>VENUE</small><b>${esc(e.venue)}</b></div><div><small>AREA</small><b>${esc(e.area)}</b></div>
          <div><small>TICKETS</small><b>${b.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</b></div><div><small>NAME</small><b>${esc(b.attendee?.name || '')}</b></div>
        </div>
      </div>
      <div class="stub-right">${b.status === 'confirmed' ? `<div id="qr" class="qr" aria-label="Ticket QR code"></div><b class="code">${esc(b.code)}</b><small>Show this at entry</small>` : `<b class="code">${esc(b.status.toUpperCase())}</b>${b.refund ? `<small>Refund of ${money(b.refund)} initiated</small>` : ''}`}</div>
    </div>
    ${b.status === 'confirmed' ? `<div class="action-row wrap">
      <a class="btn primary" target="_blank" rel="noopener" href="https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(e.title)}&dates=${f(e.start)}/${f(end)}&location=${encodeURIComponent(e.venue + ', ' + e.area)}&details=${encodeURIComponent('Funillion ticket ' + b.code)}">＋ Google Calendar</a>
      <a class="btn ghost" href="/api/bookings/${b.id}/ics">⤓ Apple / Outlook (.ics)</a>
      <a class="btn ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${e.lat},${e.lng}">⌖ Directions</a>
      <a class="btn ghost" href="#/event/${e.id}">Event page</a>
      ${hoursLeft > 0 ? `<button class="btn danger" id="cancel">Cancel booking</button>` : ''}
    </div>
    <div class="receipt"><div><span>Paid via</span><b>${esc((b.method || '').toUpperCase())}</b></div><div><span>Payment ref</span><b>${esc(b.paymentRef || '')}</b></div><div><span>Total</span><b>${money(b.total)}</b></div></div>
    <p class="fine">Cancellation: full ticket refund up to 24h before the event, 50% after that. Booking fee is non-refundable.</p>` : `<a class="btn" href="#/tickets">Back to my tickets</a>`}
  </div>`;
  if (b.status === 'confirmed' && window.QRCode) new QRCode($('#qr'), { text: `FUNILLION|${b.id}|${b.code}`, width: 148, height: 148, colorDark: '#181a17', colorLight: '#ffffff' });
  $('#cancel')?.addEventListener('click', async () => {
    const refund = hoursLeft >= 24 ? b.subtotal : Math.round(b.subtotal * 0.5);
    if (!window.confirm(`Cancel this booking? You'll get ${money(refund)} back.`)) return;
    try { await api(`/bookings/${b.id}/cancel`, { method: 'POST' }); toast('Booking cancelled — refund initiated'); ticket(el, id); } catch (err) { toast(err.message, 'error'); }
  });
}

export async function tickets(el) {
  if (!requireAuth('Log in to see your tickets')) { el.innerHTML = `<div class="empty"><h3>Your tickets live here</h3><p>Log in to see bookings.</p></div>`; return; }
  loading(el);
  const { items } = await api('/bookings');
  const now = Date.now();
  const up = items.filter(b => b.status === 'confirmed' && new Date(b.event.end || b.event.start) > now);
  const rest = items.filter(b => !up.includes(b));
  const row = b => `<a class="ticket-row ${b.status}" href="#/ticket/${b.id}"><div class="tr-date"><small>${new Date(b.event.start).toLocaleDateString('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' }).toUpperCase()}</small><b>${new Date(b.event.start).toLocaleDateString('en-IN', { day: 'numeric', timeZone: 'Asia/Kolkata' })}</b></div>
    <div class="tr-main"><b>${esc(b.event.title)}</b><span>${relDay(b.event.start)} · ${fmtTime(b.event.start)} · ${esc(b.event.venue)}, ${esc(b.event.area)}</span><span>${b.items.map(i => `${i.qty}× ${esc(i.name)}`).join(', ')}</span></div>
    <div class="tr-side">${b.status === 'confirmed' ? `<b>${esc(b.code)}</b>` : `<span class="tag outline">${esc(b.status)}</span>`}<span>${money(b.total)}</span></div></a>`;
  el.innerHTML = `<div class="narrow"><p class="eyebrow">MY TICKETS</p><h1>Your plans</h1>
    <h3 class="sub">Upcoming (${up.length})</h3>${up.length ? up.map(row).join('') : `<div class="empty small"><p>No upcoming tickets. <a class="link" href="#/discover">Find something fun →</a></p></div>`}
    ${rest.length ? `<h3 class="sub">Past & cancelled</h3>${rest.map(row).join('')}` : ''}</div>`;
}
