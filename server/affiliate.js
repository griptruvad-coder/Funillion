// Affiliate links for listed events (e.g. BookMyShow via Admitad/EarnKaro/INRDeals).
// AFFILIATE_TEMPLATES='{"bookmyshow.com":"https://your-affiliate-network/redirect?url={url}"}'
let rules = {};
try { rules = JSON.parse(process.env.AFFILIATE_TEMPLATES || '{}'); } catch { console.warn('AFFILIATE_TEMPLATES is not valid JSON — ignoring'); }
function wrap(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const key = Object.keys(rules).find(d => host === d || host.endsWith('.' + d));
    return key ? rules[key].replace('{url}', encodeURIComponent(url)) : url;
  } catch { return url; }
}
module.exports = { wrap };
