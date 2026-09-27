const { SOURCES: HACKATHON_SOURCES } = require('./hackathons');

// Which websites the crawler reads, and where it starts on each.
// Every URL still goes through that site's robots.txt at runtime — if a site disallows it, it is skipped.
// Add a site: give it an id, name, the listing pages per city (seeds) and/or sitemaps, and a pattern for event detail URLs.

// our city id → each site's own slug
const SLUGS = {
  allevents: { delhi: 'new-delhi', mumbai: 'mumbai', bengaluru: 'bangalore', hyderabad: 'hyderabad', chennai: 'chennai', kolkata: 'kolkata', pune: 'pune-in', ahmedabad: 'ahmedabad', jaipur: 'jaipur', chandigarh: 'chandigarh', lucknow: 'lucknow', goa: 'goa', kochi: 'kochi', indore: 'indore' },
  eventbrite: { delhi: 'new-delhi', mumbai: 'mumbai', bengaluru: 'bangalore', hyderabad: 'hyderabad', chennai: 'chennai', kolkata: 'kolkata', pune: 'pune', ahmedabad: 'ahmedabad', jaipur: 'jaipur', chandigarh: 'chandigarh', lucknow: 'lucknow', goa: 'goa', kochi: 'kochi', indore: 'indore' },
  townscript: { delhi: 'delhi', mumbai: 'mumbai', bengaluru: 'bangalore', hyderabad: 'hyderabad', chennai: 'chennai', kolkata: 'kolkata', pune: 'pune', ahmedabad: 'ahmedabad', jaipur: 'jaipur', chandigarh: 'chandigarh', lucknow: 'lucknow', goa: 'goa', kochi: 'kochi', indore: 'indore' },
  luma: { delhi: 'new-delhi', mumbai: 'mumbai', bengaluru: 'bengaluru', hyderabad: 'hyderabad', chennai: 'chennai', pune: 'pune', kolkata: 'kolkata', goa: 'goa' },
  bookmyshow: { delhi: 'national-capital-region-ncr', mumbai: 'mumbai', bengaluru: 'bengaluru', hyderabad: 'hyderabad', chennai: 'chennai', kolkata: 'kolkata', pune: 'pune', ahmedabad: 'ahmedabad', jaipur: 'jaipur', chandigarh: 'chandigarh', lucknow: 'lucknow', goa: 'goa', kochi: 'kochi', indore: 'indore' },
};
const seedsFor = (id, fn) => Object.entries(SLUGS[id]).map(([city, slug]) => ({ city, url: fn(slug) }));

const SITES = [
  { id: 'allevents', name: 'AllEvents', enabled: true, eventPattern: /^\/[a-z0-9-]+\/[a-z0-9-]+\/\d{8,}/i,
    seeds: seedsFor('allevents', s => `https://allevents.in/${s}/all`) },
  { id: 'district', name: 'District', enabled: true, eventPattern: /^\/events\/[a-z0-9-]+-buy-tickets|^\/events\/[a-z0-9-]*-(?:[a-z0-9]{6,})$/i,
    seeds: [{ url: 'https://www.district.in/events/' }], sitemapFilter: /event/i },
  { id: 'eventbrite', name: 'Eventbrite', enabled: true, eventPattern: /^\/e\/[a-z0-9-]+-\d{6,}/i,
    seeds: seedsFor('eventbrite', s => `https://www.eventbrite.com/d/india--${s}/events/`) },
  { id: 'townscript', name: 'Townscript', enabled: true, eventPattern: /^\/e\/[a-z0-9-]+$/i,
    seeds: seedsFor('townscript', s => `https://www.townscript.com/in/${s}`) },
  { id: 'luma', name: 'Luma', enabled: true, eventPattern: /^\/[a-z0-9]{8}$/i,
    seeds: seedsFor('luma', s => `https://luma.com/${s}`) },
  // Hackathon platforms (Devpost, Unstop, Devfolio, HackerEarth, Hack2Skill) read their public listing JSON — see hackathons.js
  // Off by default: BookMyShow's terms restrict automated access. Enable only with their permission (CRAWL_SITES=...,bookmyshow).
  { id: 'bookmyshow', name: 'BookMyShow', enabled: false, eventPattern: /^\/events\/[a-z0-9-]+\/ET\d+/i,
    seeds: seedsFor('bookmyshow', s => `https://in.bookmyshow.com/explore/events-${s}`) },
];

// extra sites without code changes: CRAWL_EXTRA='[{"id":"highape","name":"HighApe","seeds":["https://highape.com/delhi"],"eventPattern":"/event/"}]'
function extraSites() {
  try {
    return JSON.parse(process.env.CRAWL_EXTRA || '[]').map(s => ({ enabled: true, ...s, eventPattern: new RegExp(s.eventPattern || '/event', 'i'), sitemapFilter: s.sitemapFilter ? new RegExp(s.sitemapFilter, 'i') : undefined, hostPattern: s.hostPattern ? new RegExp(s.hostPattern, 'i') : undefined, seeds: (s.seeds || []).map(u => (typeof u === 'string' ? { url: u } : u)) }));
  } catch { console.warn('CRAWL_EXTRA is not valid JSON — ignoring'); return []; }
}

function activeSites() {
  const only = (process.env.CRAWL_SITES || '').split(',').map(s => s.trim()).filter(Boolean);
  const all = [...SITES, ...HACKATHON_SOURCES, ...extraSites()];
  return all.filter(s => (only.length ? only.includes(s.id) : s.enabled));
}

module.exports = { SITES, HACKATHON_SOURCES, activeSites };
