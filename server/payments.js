// Razorpay integration (Standard Checkout)
// Flow: server creates an Order → browser opens Razorpay Checkout → server verifies the signature → booking confirmed.
// A webhook (payment.captured / order.paid) confirms bookings even if the user closes the tab after paying.
// Without keys in env, Funillion falls back to the demo gateway so local development keeps working.
const crypto = require('crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const API = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1';
const BRAND = process.env.BRAND_NAME || 'Funillion';

const enabled = () => Boolean(KEY_ID && KEY_SECRET);
const mode = () => (!enabled() ? 'demo' : KEY_ID.startsWith('rzp_live_') ? 'live' : 'test');

async function call(method, path, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(API + path, {
      method, signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64') },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data?.error?.description || `Razorpay error ${res.status}`); e.razorpay = data?.error; throw e; }
    return data;
  } finally { clearTimeout(t); }
}

// amounts in Razorpay are in paise
const createOrder = (b, ev) => call('POST', '/orders', {
  amount: Math.round(b.total * 100), currency: 'INR', receipt: b.id.slice(0, 40),
  notes: { bookingId: b.id, eventId: b.eventId, event: String(ev?.title || '').slice(0, 250) },
});
const fetchPayment = id => call('GET', `/payments/${encodeURIComponent(id)}`);
const refund = (paymentId, amountRupees, notes = {}) => call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: Math.round(amountRupees * 100), speed: 'normal', notes });

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// signature Checkout returns: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
const verifyCheckout = ({ orderId, paymentId, signature }) =>
  safeEqualHex(crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex'), signature);
// webhook signature: HMAC_SHA256(raw request body, webhook_secret)
const verifyWebhook = (rawBody, signature) =>
  Boolean(WEBHOOK_SECRET) && safeEqualHex(crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex'), signature);

const publicConfig = () => ({ provider: enabled() ? 'razorpay' : 'demo', mode: mode(), keyId: enabled() ? KEY_ID : null, brand: BRAND, webhook: Boolean(WEBHOOK_SECRET) });

module.exports = { enabled, mode, createOrder, fetchPayment, refund, verifyCheckout, verifyWebhook, publicConfig, KEY_ID };
