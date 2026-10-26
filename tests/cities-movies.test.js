const test = require('node:test');
const assert = require('node:assert/strict');
const { CITIES } = require('../server/catalog');
const directory = require('../server/cities');
const { activeSites } = require('../server/crawler/sites');
const { toRecord } = require('../server/crawler/extract');
const seo = require('../server/seo');
const { createMovieService } = require('../server/movies');

const NOW = Date.parse('2026-10-26T06:30:00Z');
const iso = delta => new Date(NOW + delta).toISOString();
const request = { city: 'delhi', date: '2026-10-26', radiusKm: 15 };
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function schedule() {
  return { source: 'Integration test partner', city: 'delhi', date: request.date, updatedAt: iso(0), partial: false,
    cinemas: [{ id: 'c1', name: 'Fixture cinema', lat: 28.615, lng: 77.21, address: 'Test address' }],
    movies: [{ id: 'm1', title: 'Integration fixture film' }, { id: 'not-playing', title: 'Not locally showing' }],
    showtimes: [{ id: 's1', cinemaId: 'c1', movieId: 'm1', startsAt: iso(3600000), language: 'Hindi', format: '2D', offers: [{ id: 'o1', provider: 'Partner', currency: 'INR', price: 200, fees: 25, availableTickets: 3, bookingUrl: 'https://in.bookmyshow.com/buytickets/fixture', checkedAt: iso(0), expiresAt: iso(300000) }] }],
  };
}
const feedEnv = { MOVIES_FEED_URL: 'https://partner.example/schedule' };

test('India directory covers 36 states/UTs and keeps distinct metro satellite cities', () => {
  assert.ok(CITIES.length > 7000);
  assert.equal(new Set(CITIES.map(c => c.state)).size, 36);
  assert.equal(new Set(CITIES.map(c => c.id)).size, CITIES.length);
  assert.ok(CITIES.every(c => Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.areas.length));
  for (const name of ['Delhi', 'Noida', 'Gurugram', 'Thane', 'Navi Mumbai', 'Greater Noida', 'Leh', 'Kavaratti', 'Port Blair', 'Imphal', 'Itanagar']) assert.ok(directory.resolveCity(name), name);
  assert.notEqual(directory.resolveCity('Noida'), 'delhi');
  assert.equal(directory.resolveCity('Gurgaon'), 'gurugram');
  assert.equal(directory.resolveCity('Bangalore'), 'bengaluru');
  for (const c of CITIES.filter(c => c.featured)) assert.equal(directory.resolveCity(c.short), c.id, `legacy city ${c.short}`);
  assert.equal(directory.resolveCity('North Goa'), 'goa');
  assert.notEqual(directory.resolveCity('Thane'), 'mumbai');
  assert.equal(directory.findCity(directory.resolveCity('Aurangabad', 'Bihar')).state, 'Bihar');
  assert.ok(directory.searchCities('हैदराबाद').some(c => c.id === 'hyderabad'));
  assert.ok(directory.searchCities('', 'Haryana').every(c => c.state === 'Haryana'));
});

test('crawler discovers requested cities outside the old 14-city list', () => {
  const sites = activeSites(['surat', 'greater-noida']);
  const allEvents = sites.find(s => s.id === 'allevents');
  assert.ok(allEvents.seeds.some(s => s.city === 'surat' && s.url.includes('/surat/')));
  assert.ok(allEvents.seeds.some(s => s.city === 'greater-noida'));
  assert.ok(!sites.some(s => s.id === 'bookmyshow'));
});

test('nationwide ingestion rejects international namesakes and conflicting coordinates', () => {
  const event = { '@type': 'Event', name: 'Fixture event', startDate: '2030-12-01T18:00:00+05:30', location: { name: 'Fixture venue', address: { addressLocality: 'Salem', addressCountry: 'US' } } };
  assert.equal(toRecord(event, 'https://events.example/fixture', { name: 'Fixture' }).skip, 'outside India');
  event.location.address = { addressLocality: 'Surat', addressRegion: 'Gujarat', addressCountry: 'IN' };
  event.location.geo = { latitude: 40.7, longitude: -74 };
  assert.equal(toRecord(event, 'https://events.example/fixture', { name: 'Fixture' }).skip, 'city and coordinates conflict');
  event.location.geo = { latitude: 21.17, longitude: 72.83 };
  assert.equal(toRecord(event, 'https://events.example/fixture', { name: 'Fixture' }).record.city, 'surat');
});

function seoResponse(path, events = {}) {
  let body, status;
  const res = { writeHead: s => { status = s; }, end: b => { body = b; } };
  assert.equal(seo.handle({ events }, { headers: { host: 'localhost' } }, res, new URL(path, 'http://localhost')), true);
  return { status, body };
}
test('SEO serves hyphenated city IDs and publishes only populated event sitemaps', () => {
  assert.equal(seoResponse('/in/greater-noida').status, 200);
  assert.match(seoResponse('/in/greater-noida').body, /noindex,follow/);
  assert.equal(seoResponse('/sitemaps/events-greater-noida.xml').status, 200);
  const event = { city: 'greater-noida', status: 'live', start: '2030-12-01T12:00:00Z', category: 'hackathons', title: 'Fixture', id: 'ev_fixture', sources: [] };
  const result = seoResponse('/sitemap.xml', { ev_fixture: event });
  assert.match(result.body, /events-greater-noida.xml/);
  assert.doesNotMatch(result.body, /events-mumbai.xml/);
  assert.ok(result.body.length < 2000);
  assert.ok(seoResponse('/cities?q=Surat').body.includes('Surat'));
});

test('local availability requires recent, future, city-specific showtimes', async () => {
  let raw = schedule();
  const service = createMovieService({ env: feedEnv, now: () => NOW, fetchImpl: async url => { assert.equal(new URL(url).searchParams.get('city'), 'delhi'); return response(raw); } });
  let result = await service.load(request);
  assert.equal(result.status, 'live');
  assert.deepEqual(result.movies.map(m => m.id), ['m1']);
  assert.equal(result.showtimes[0].offers[0].total, 225);
  raw.showtimes.push({ ...raw.showtimes[0], id: 'past', startsAt: iso(-1000) });
  raw.showtimes.push({ ...raw.showtimes[0], id: 'wrong-date', startsAt: iso(2 * 86400000) });
  result = await service.load(request);
  assert.equal(result.showtimes.length, 1);
  raw.updatedAt = iso(-16 * 60000);
  result = await service.load(request);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.movies.length, 0);
  raw.updatedAt = iso(0); raw.city = 'mumbai';
  assert.equal((await service.load(request)).status, 'unavailable');
});

test('expired, invalid and unsafe price offers are excluded; missing fees stay unknown', async () => {
  const raw = schedule(), offer = raw.showtimes[0].offers[0];
  raw.showtimes[0].offers.push({ ...offer, id: 'expired', expiresAt: iso(-1) }, { ...offer, id: 'stale', checkedAt: iso(-16 * 60000) }, { ...offer, id: 'unsafe', bookingUrl: 'javascript:alert(1)' }, { ...offer, id: 'host', bookingUrl: 'https://bookmyshow.com.evil.example/' }, { ...offer, id: 'null-price', price: null }, { ...offer, id: 'unknown-fees', fees: null }, { ...offer, id: 'free', price: 0, fees: 0 });
  const service = createMovieService({ env: feedEnv, now: () => NOW, fetchImpl: async () => response(raw) });
  const result = await service.load(request), offers = result.showtimes[0].offers;
  assert.deepEqual(offers.map(o => o.id), ['o1', 'unknown-fees', 'free']);
  assert.equal(offers[1].total, null);
  assert.equal(offers[2].total, 0);
  assert.equal(service.safeBooking('https://in.bookmyshow.com/x'), 'https://in.bookmyshow.com/x');
});

test('booking rechecks current price, expiration and quantity before a partner handoff', async () => {
  const raw = schedule();
  const service = createMovieService({ env: feedEnv, now: () => NOW, fetchImpl: async () => response(raw) });
  const book = { ...request, showtimeId: 's1', offerId: 'o1', expectedPrice: 200, expectedTotal: 225, tickets: 2 };
  assert.equal((await service.book(book)).amount, 450);
  raw.showtimes[0].offers[0].price = 250;
  await assert.rejects(service.book(book), /price has changed/);
  raw.showtimes[0].offers[0].price = 200;
  await assert.rejects(service.book({ ...book, tickets: 4 }), /not enough/);
  raw.showtimes[0].offers[0].expiresAt = iso(-1);
  await assert.rejects(service.book(book), /expired/);
});

test('without movie credentials, OSM returns a directory and never invents movies or prices', async () => {
  let calls = 0;
  const service = createMovieService({ env: {}, now: () => NOW, fetchImpl: async () => { calls++; return response({ elements: [{ id: 1, type: 'node', lat: 28.615, lon: 77.21, tags: { name: 'Map cinema' } }] }); } });
  let result = await service.load(request);
  assert.equal(result.status, 'not-connected');
  assert.equal(result.cinemaCount, 1);
  assert.equal(result.movies.length, 0);
  assert.equal(result.showtimes.length, 0);
  await service.load(request);
  assert.equal(calls, 1, 'only the OSM directory can be cached');
  const failed = createMovieService({ env: {}, now: () => NOW, fetchImpl: async () => { throw new Error('offline'); } });
  result = await failed.load(request);
  assert.equal(result.cinemaCount, null, 'failure must not look like a city with zero cinemas');
  assert.equal(result.status, 'unavailable');
});

test('MovieGlu uses actual cinema schedules, preserves business dates and obtains a booking deep link', async () => {
  const calls = [];
  const service = createMovieService({ now: () => NOW, env: { MOVIEGLU_CLIENT: 'fixture', MOVIEGLU_API_KEY: 'fixture', MOVIEGLU_AUTHORIZATION: 'Basic fixture' }, fetchImpl: async (url, options) => {
    const u = new URL(url); calls.push(u.pathname);
    assert.equal(options.headers.territory, 'IN');
    assert.match(options.headers['device-datetime'], /^2026-10-26T12:00:00/);
    if (u.pathname.includes('cinemasNearby')) return response({ cinemas: [{ cinema_id: 1, cinema_name: 'Fixture cinema', lat: 28.615, lng: 77.21 }] });
    if (u.pathname.includes('cinemaShowTimes')) return response({ films: [{ film_id: 10, film_name: 'Fixture movie', showings: { Standard: { film_id: 10, times: [{ start_time: '13:00' }, { start_time: '00:30' }] } } }] });
    if (u.pathname.includes('purchaseConfirmation')) { assert.equal(u.searchParams.get('date'), '2026-10-26'); assert.equal(u.searchParams.get('time'), '13:00'); return response({ url: 'https://www.pvrcinemas.com/booking' }); }
    throw new Error('unexpected resource');
  } });
  const result = await service.load(request);
  assert.equal(result.showtimes.length, 2);
  assert.equal(result.showtimes[1].startsAt, '2026-10-26T19:00:00.000Z');
  assert.equal(result.showtimes[0].offers.length, 0);
  const booking = await service.book({ ...request, showtimeId: result.showtimes[0].id });
  assert.equal(booking.url, 'https://www.pvrcinemas.com/booking');
  assert.equal(calls.filter(p => p.includes('cinemasNearby')).length, 2);
});

test('Hinglish preferences work without an AI key, and invalid dates/coordinates are rejected', async () => {
  const service = createMovieService({ env: {}, now: () => NOW });
  const p = await service.preferences('2 tickets Hindi shaam ko total ₹800 ke andar');
  assert.equal(p.budget, 800); assert.equal(p.people, 2); assert.equal(p.language, 'Hindi'); assert.equal(p.afterHour, 17);
  assert.throws(() => service.context({ ...request, date: '2026-10-32' }), /date/);
  assert.throws(() => service.context({ ...request, lat: 19.076, lng: 72.8777 }), /outside/);
  assert.throws(() => service.context({ ...request, lat: '', lng: 77 }), /outside/);
});
