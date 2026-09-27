// Event Submission Engine: organiser pastes a URL -> we extract a draft listing.
// Reads schema.org Event JSON-LD first (what most ticketing sites publish), then Open Graph / meta tags.
const dns = require('dns').promises;
const net = require('net');
const { resolveCity, resolveArea, inferCategory } = require('./aggregator');

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80') || ip.startsWith('::ffff:127.') || ip.startsWith('::ffff:10.') || ip.startsWith('::ffff:192.168.');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function safeFetch(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That does not look like a valid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) links are supported');
  const { address } = await dns.lookup(u.hostname).catch(() => { throw new Error('Could not resolve that website'); });
  if (isPrivateIp(address)) throw new Error('That address is not allowed');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(u, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': 'FunillionBot/1.0 (+event import)', accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok) throw new Error(`The page returned ${res.status}`);
    const reader = res.body.getReader(); const chunks = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; chunks.push(value); if (size > 2_000_000) break; }
    return Buffer.concat(chunks).toString('utf8');
  } catch (e) { if (e.name === 'AbortError') throw new Error('The page took too long to respond'); throw e; }
  finally { clearTimeout(t); }
}

const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
function meta(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0]; if (!tag) return null;
  return decode(tag.match(/content=["']([^"']*)["']/i)?.[1]);
}

function findEventLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  for (const b of blocks) {
    let data; try { data = JSON.parse(b.trim()); } catch { continue; }
    const stack = Array.isArray(data) ? [...data] : [data];
    while (stack.length) {
      const n = stack.shift(); if (!n || typeof n !== 'object') continue;
      const type = [].concat(n['@type'] || []).join(' ');
      if (/Event/i.test(type)) return n;
      if (n['@graph']) stack.push(...n['@graph']);
    }
  }
  return null;
}

function extract(html, url) {
  const ld = findEventLd(html);
  const draft = { sourceUrl: url, confidence: {}, title: null, description: null, start: null, durH: 3, venue: null, locality: null, city: null, price: null, image: null, category: null, organizer: null };
  if (ld) {
    draft.title = decode(ld.name); draft.description = decode(ld.description).slice(0, 1200);
    if (ld.startDate) { const d = new Date(ld.startDate); if (!isNaN(d)) draft.start = d.toISOString(); }
    if (ld.endDate && draft.start) { const e = new Date(ld.endDate); if (!isNaN(e)) draft.durH = Math.max(0.5, Math.min(72, (e - new Date(draft.start)) / 3600000)); }
    const loc = [].concat(ld.location || [])[0] || {};
    draft.venue = decode(loc.name);
    const addr = typeof loc.address === 'string' ? { streetAddress: loc.address } : (loc.address || {});
    draft.locality = decode([addr.streetAddress, addr.addressLocality].filter(Boolean).join(', '));
    draft.city = resolveCity(addr.addressLocality, addr.addressRegion, draft.locality, loc.name);
    const offer = [].concat(ld.offers || [])[0];
    if (offer) draft.price = Number(offer.price ?? offer.lowPrice ?? 0) || 0;
    draft.image = [].concat(ld.image || [])[0]; if (draft.image && typeof draft.image === 'object') draft.image = draft.image.url;
    draft.organizer = decode([].concat(ld.organizer || [])[0]?.name);
    draft.confidence.structured = true;
  }
  draft.title ||= meta(html, 'og:title') || decode(html.match(/<title[^>]*>([^<]*)/i)?.[1]);
  draft.description ||= (meta(html, 'og:description') || meta(html, 'description') || '').slice(0, 1200);
  draft.image ||= meta(html, 'og:image');
  if (!draft.start) {
    const t = meta(html, 'event:start_time') || meta(html, 'startDate');
    if (t && !isNaN(new Date(t))) draft.start = new Date(t).toISOString();
  }
  if (!draft.city) draft.city = resolveCity(meta(html, 'og:locality'), draft.title, draft.description);
  draft.category = inferCategory(draft.title, draft.description);
  if (draft.city) draft.area = resolveArea(draft.city, `${draft.locality || ''} ${draft.venue || ''}`)?.name || null;
  draft.confidence.fields = ['title', 'start', 'venue', 'city', 'price', 'image'].filter(k => draft[k] != null && draft[k] !== '');
  return draft;
}

async function importFromUrl(url) { const html = await safeFetch(url); return extract(html, url); }

module.exports = { importFromUrl, extract };
