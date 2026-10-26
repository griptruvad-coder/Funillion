// GeoNames city directory. Legacy IDs stay stable so existing accounts and URLs work.
const rows = require('./cities-india.json');
const clean = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const slug = s => clean(s).replace(/[^a-z0-9 ]/g, '').replace(/ +/g, '-');
let cities = [], byId = new Map(), aliases = new Map(), phrases = [];

function extendCities(base) {
  const names = new Map(base.flatMap(c => [c.id, c.name, c.short].map(n => [clean(n), c])));
  const existing = new Set(base.map(c => c.id));
  const addAlias = (name, c) => { const key = clean(name); if (!key) return; const list = aliases.get(key) || []; if (!list.includes(c)) list.push(c); aliases.set(key, list); };
  for (const c of base) { c.featured = true; c.aliases = []; }
  for (const r of rows) {
    const [geoId, name, ascii, state, lat, lng, population, alternatives] = r;
    let c = names.get(clean(ascii)) || names.get(clean(name));
    if (ascii === 'New Delhi') c = base.find(c => c.id === 'delhi');
    // Two towns with the same name can belong to different states.
    if (c && (c.state !== state || Math.abs(c.lat - lat) > .15 || Math.abs(c.lng - lng) > .15)) c = null;
    if (!c) {
      let id = slug(ascii) || `city-${geoId}`;
      if (existing.has(id)) id += `-${slug(state)}-${geoId}`;
      c = { id, name: ascii || name, short: ascii || name, state, lat, lng, population, geoId, weight: 0, speed: 22, aliases: [], areas: [{ name: `${ascii || name} centre`, lat, lng, zone: 'central' }] };
      base.push(c); existing.add(id); names.set(clean(ascii), c);
    }
    c.population = Math.max(c.population || 0, population);
    c.aliases.push(name, ascii, ...(alternatives || []));
  }
  cities = base; byId = new Map(cities.map(c => [c.id, c]));
  for (const c of cities) for (const name of [c.id, c.short, c.name, ...c.aliases]) addAlias(name, c);
  const historical = { bangalore: 'bengaluru', bombay: 'mumbai', calcutta: 'kolkata', madras: 'chennai', cochin: 'kochi', dilli: 'delhi', ncr: 'delhi', gurgaon: 'gurugram', allahabad: 'prayagraj', pondicherry: 'puducherry', 'north goa': 'goa', 'south goa': 'goa', 'chandigarh tricity': 'chandigarh' };
  for (const [alias, id] of Object.entries(historical)) if (byId.has(id)) addAlias(alias, byId.get(id));
  phrases = [...aliases.keys()].filter(k => k.length >= 4).sort((a, b) => b.length - a.length);
  return base;
}

function resolveCity(...hints) {
  const text = hints.map(clean).filter(Boolean), joined = ` ${text.join(' ')} `;
  const choose = (list, name) => {
    if (list.length === 1) return list[0].id;
    const stateMatch = list.filter(c => joined.includes(` ${clean(c.state)} `));
    const candidates = stateMatch.length ? stateMatch : list;
    // Curated legacy locations (notably Goa) win over a larger town's alternate name.
    const canonical = candidates.filter(c => c.featured || clean(c.id) === name);
    return [...(canonical.length ? canonical : candidates)].sort((a, b) => (b.population || 0) - (a.population || 0))[0]?.id || null;
  };
  for (const h of text) if (aliases.has(h)) return choose(aliases.get(h), h);
  for (const name of phrases) if (joined.includes(` ${name} `)) return choose(aliases.get(name), name);
  return null;
}

function searchCities(q = '', state = '', limit = 60) {
  const needle = clean(q);
  return cities.filter(c => (!state || c.state === state) && (!needle || [c.name, c.state, ...c.aliases].some(n => clean(n).includes(needle))))
    .sort((a, b) => Number(clean(b.short) === needle) - Number(clean(a.short) === needle) || Number(b.featured || false) - Number(a.featured || false) || (b.population || 0) - (a.population || 0)).slice(0, limit);
}

module.exports = { extendCities, resolveCity, searchCities, findCity: id => byId.get(id), clean };
