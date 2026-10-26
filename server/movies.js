// Live movie discovery. Showtimes establish local availability; AI never supplies inventory.
const { CITIES } = require('./catalog');
const { findCity } = require('./cities');
const { istDayKey, addDaysKey, haversineKm } = require('./util');
const crypto = require('crypto');
const idOf = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
const text = (s, max = 160) => String(s || '').slice(0, max);
const numeric = v => v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
const coords = p => numeric(p?.lat) !== null && numeric(p?.lng) !== null && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const httpsUrl = s => { try { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; } };

function createMovieService({ fetchImpl = fetch, now = Date.now, env = process.env } = {}) {
  const osmCache = new Map(), pending = new Map();
  let active = 0, day = '', used = 0;
  const limit = Math.max(1, Number(env.MOVIEGLU_DAILY_LIMIT) || 300);
  const bookingHosts = (env.MOVIES_BOOKING_HOSTS || 'bookmyshow.com,district.in,pvrcinemas.com,inoxmovies.com,cinepolisindia.com,movieglu.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const safeBooking = url => {
    const safe = httpsUrl(url); if (!safe) return null;
    const host = new URL(safe).hostname;
    return bookingHosts.some(h => host === h || host.endsWith('.' + h)) ? safe : null;
  };
  const configured = () => Boolean(env.MOVIES_FEED_URL || (env.MOVIEGLU_CLIENT && env.MOVIEGLU_API_KEY && env.MOVIEGLU_AUTHORIZATION));

  function context(query) {
    const city = findCity(query.city);
    if (!city) throw fault('Choose an Indian city.');
    const today = istDayKey(new Date(now())), date = query.date || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date < today || date > addDaysKey(today, 7)) throw fault('Choose a date from today to the next 7 days.');
    const customLocation = query.lat !== undefined && query.lat !== null && query.lat !== '' || query.lng !== undefined && query.lng !== null && query.lng !== '';
    if (customLocation && (!coords(query) || haversineKm(query, city) > 100)) throw fault('Your location is outside this city. Choose your nearest city first.');
    const lat = customLocation ? Number(query.lat) : city.lat, lng = customLocation ? Number(query.lng) : city.lng;
    const radiusKm = Number(query.radiusKm || 15);
    if (![5, 10, 15, 25, 50].includes(radiusKm)) throw fault('Choose a radius of 5, 10, 15, 25 or 50 km.');
    return { city, date, today, lat, lng, radiusKm, locationMode: customLocation ? 'device' : 'city-centre' };
  }

  async function json(url, { headers = {}, method = 'GET', body, timeout = 14000 } = {}) {
    const response = await fetchImpl(url, { method, body, headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout), redirect: 'error' });
    if (response.status === 204) return {};
    if (!response.ok) throw fault('Live movie source is temporarily unavailable. Please try again.', 503);
    if (Number(response.headers?.get('content-length') || 0) > 6_000_000) throw fault('Movie source returned too much data.', 503);
    // Bound streamed responses as well as Content-Length.
    if (!response.body?.getReader) return response.json();
    const reader = response.body.getReader(), chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 6_000_000) { await reader.cancel(); throw fault('Movie source returned too much data.', 503); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function movieglu(resource, params, ctx) {
    const today = istDayKey(new Date(now()));
    if (day !== today) { day = today; used = 0; }
    if (used >= limit) throw fault('Live movie requests are busy today. Please try later.', 503);
    used++;
    const url = new URL(resource + '/', 'https://api-gate2.movieglu.com/');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return json(url, { headers: {
      client: env.MOVIEGLU_CLIENT, 'x-api-key': env.MOVIEGLU_API_KEY,
      authorization: env.MOVIEGLU_AUTHORIZATION, territory: 'IN', 'api-version': 'v200',
      geolocation: `${ctx.lat.toFixed(6)};${ctx.lng.toFixed(6)}`,
      'device-datetime': new Date(now() + 330 * 60000).toISOString().replace(/Z$/, ''),
    } });
  }

  async function fromMovieglu(ctx) {
    // cinemasNearby and purchaseConfirmation are never cached, as required by MovieGlu.
    const nearby = await movieglu('cinemasNearby', { n: 25 }, ctx);
    const cinemas = (nearby.cinemas || []).filter(coords).map(c => ({ id: String(c.cinema_id), name: text(c.cinema_name), address: text([c.address, c.address2, c.city].filter(Boolean).join(', '), 300), lat: Number(c.lat), lng: Number(c.lng) })).filter(c => haversineKm(c, ctx) <= ctx.radiusKm);
    const max = Math.max(1, Math.min(25, Number(env.MOVIEGLU_MAX_CINEMAS) || 8));
    const movies = [], showtimes = [], notices = []; let failures = 0;
    // Limit concurrency to three requests; report partial results if a cinema is unavailable.
    const selected = cinemas.slice(0, max);
    for (let i = 0; i < selected.length; i += 3) {
      await Promise.all(selected.slice(i, i + 3).map(async cinema => {
        try {
          const result = await movieglu('cinemaShowTimes', { cinema_id: cinema.id, date: ctx.date }, ctx);
          for (const f of result.films || []) {
            const movieId = String(f.film_id);
            movies.push({ id: movieId, title: f.film_name, image: f.film_image, rating: f.age_rating?.[0]?.rating });
            for (const [format, version] of Object.entries(f.showings || {})) for (const t of version.times || []) {
              if (!/^\d{2}:\d{2}$/.test(t.start_time)) continue;
              const date = t.start_time < '03:00' ? addDaysKey(ctx.date, 1) : ctx.date;
              showtimes.push({ id: idOf(cinema.id, movieId, ctx.date, format, t.start_time), movieId, cinemaId: cinema.id, startsAt: `${date}T${t.start_time}:00+05:30`, format, language: version.language || f.language || '', bookingKind: 'movieglu', providerFilmId: String(version.film_id || f.film_id), serviceDate: ctx.date, time: t.start_time, offers: [] });
            }
          }
        } catch { failures++; }
      }));
    }
    if (cinemas.length > selected.length) notices.push(`Showtimes checked at ${selected.length} of the ${cinemas.length} cinemas found. Narrow your radius to see closer options.`);
    if (failures) notices.push(`${failures} cinema schedules could not be loaded. Results are partial.`);
    if (nearby.cinemas?.length === 25) notices.push('Cinema search returned the nearest 25 matches; this is not a complete city census.');
    return { source: 'MovieGlu', updatedAt: new Date(now()).toISOString(), cinemas, movies, showtimes, notices, partial: failures > 0 || cinemas.length > selected.length || nearby.cinemas?.length === 25 };
  }

  async function fromFeed(ctx) {
    const url = new URL(env.MOVIES_FEED_URL);
    if (url.protocol !== 'https:') throw fault('Live movie source needs an HTTPS endpoint.', 503);
    for (const [key, value] of Object.entries({ city: ctx.city.id, date: ctx.date, lat: ctx.lat, lng: ctx.lng, radiusKm: ctx.radiusKm })) url.searchParams.set(key, value);
    const result = await json(url, { headers: env.MOVIES_FEED_TOKEN ? { authorization: `Bearer ${env.MOVIES_FEED_TOKEN}` } : {} });
    if (result.city !== ctx.city.id || result.date !== ctx.date || !Array.isArray(result.cinemas) || !Array.isArray(result.movies) || !Array.isArray(result.showtimes)) throw fault('Movie source returned an invalid city schedule.', 503);
    return { ...result, source: text(result.source || 'Ticketing partner'), partial: result.partial !== false, notices: [] };
  }

  async function osm(ctx) {
    // OpenStreetMap is a directory, never a source for movie availability or prices.
    const key = `${ctx.lat.toFixed(2)}:${ctx.lng.toFixed(2)}:${ctx.radiusKm}`;
    const cached = osmCache.get(key); if (cached && now() - cached.at < 6 * 3600000) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const query = `[out:json][timeout:12];nwr[amenity=cinema](around:${ctx.radiusKm * 1000 + 2000},${ctx.lat.toFixed(2)},${ctx.lng.toFixed(2)});out center tags;`;
      // This public instance permits app use; production can configure its own endpoint.
      const endpoint = env.MOVIES_OVERPASS_URL || 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
      if (!httpsUrl(endpoint)) throw fault('Cinema directory needs an HTTPS endpoint.', 503);
      const data = await json(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Funillion/1.0 (cinema directory)' }, body: new URLSearchParams({ data: query }).toString(), timeout: 16000 });
      if (data.remark || !Array.isArray(data.elements)) throw fault('Cinema directory is temporarily unavailable.', 503);
      const seen = new Set(), cinemas = [];
      for (const e of data.elements) {
        const c = { id: `osm-${e.type}-${e.id}`, name: text(e.tags?.name || 'Cinema'), lat: Number(e.lat ?? e.center?.lat), lng: Number(e.lon ?? e.center?.lon), address: text([e.tags?.['addr:street'], e.tags?.['addr:suburb'], e.tags?.['addr:city']].filter(Boolean).join(', '), 300) };
        if (!coords(c)) continue;
        const fingerprint = `${c.name.toLowerCase()}:${c.lat.toFixed(3)}:${c.lng.toFixed(3)}`;
        if (!seen.has(fingerprint)) { seen.add(fingerprint); cinemas.push(c); }
      }
      const value = { source: 'OpenStreetMap contributors', updatedAt: new Date(now()).toISOString(), cinemas, movies: [], showtimes: [], partial: true, notices: ['Cinema directory from OpenStreetMap; some cinemas may be missing or closed.'] };
      if (osmCache.size >= 200) osmCache.delete(osmCache.keys().next().value);
      osmCache.set(key, { at: now(), value }); return value;
    })().finally(() => pending.delete(key));
    pending.set(key, task); return task;
  }

  function normalize(raw, ctx) {
    const cinemas = [...new Map((raw.cinemas || []).filter(c => c.id != null && c.name && coords(c)).map(c => [String(c.id), { id: text(c.id, 100), name: text(c.name), address: text(c.address, 300), lat: Number(c.lat), lng: Number(c.lng), distanceKm: +haversineKm(c, ctx).toFixed(1) }])).values()].filter(c => haversineKm(c, ctx) <= ctx.radiusKm).sort((a, b) => a.distanceKm - b.distanceKm);
    const cinemaIds = new Set(cinemas.map(c => c.id));
    const movies = [...new Map((raw.movies || []).filter(m => m.id != null && m.title).map(m => [String(m.id), { id: text(m.id, 100), title: text(m.title), image: httpsUrl(m.image), rating: text(m.rating, 20), synopsis: text(m.synopsis, 600) }])).values()];
    const movieIds = new Set(movies.map(m => m.id));
    const lastUpdated = Date.parse(raw.updatedAt), maxAge = 15 * 60000;
    // A timestamp is required to establish that a live schedule was recently checked.
    const live = Number.isFinite(lastUpdated) && now() - lastUpdated <= maxAge && lastUpdated <= now() + 60000;
    const ids = new Set();
    const showtimes = (live ? raw.showtimes || [] : []).filter(s => {
      const start = Date.parse(s.startsAt);
      if (!s.id || ids.has(String(s.id)) || !movieIds.has(String(s.movieId)) || !cinemaIds.has(String(s.cinemaId)) || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s.startsAt || '') || !Number.isFinite(start) || start <= now()) return false;
      const serviceDate = istDayKey(new Date(start - 3 * 3600000));
      if (serviceDate !== ctx.date) return false;
      ids.add(String(s.id)); return true;
    }).map(s => {
      const offerIds = new Set();
      const offers = (s.offers || []).filter(o => {
        const checked = Date.parse(o.checkedAt), expiry = Date.parse(o.expiresAt);
        const valid = o.id != null && !offerIds.has(String(o.id)) && o.available !== false && o.currency === 'INR' && numeric(o.price) !== null && Number(o.price) >= 0 && Number(o.price) <= 100000 && safeBooking(o.bookingUrl) && Number.isFinite(checked) && now() - checked <= maxAge && checked <= now() + 60000 && Number.isFinite(expiry) && expiry > now() && (o.fees == null || numeric(o.fees) !== null && Number(o.fees) >= 0 && Number(o.fees) <= 100000);
        if (valid) offerIds.add(String(o.id)); return valid;
      }).map(o => ({ id: text(o.id, 100), provider: text(o.provider || raw.source, 80), price: Number(o.price), fees: o.fees == null ? null : Number(o.fees), feesIncluded: o.feesIncluded === true, total: o.feesIncluded === true ? Number(o.price) : o.fees == null ? null : Number(o.price) + Number(o.fees), checkedAt: o.checkedAt, expiresAt: o.expiresAt, bookingUrl: safeBooking(o.bookingUrl), seatClass: text(o.seatClass || 'Standard', 60), availableTickets: Number.isInteger(o.availableTickets) && o.availableTickets >= 0 ? o.availableTickets : null }));
      return { id: text(s.id, 100), movieId: String(s.movieId), cinemaId: String(s.cinemaId), startsAt: new Date(s.startsAt).toISOString(), format: text(s.format || 'Standard', 30), language: text(s.language, 40), offers, bookingUrl: safeBooking(s.bookingUrl), bookingKind: s.bookingKind === 'movieglu' && raw.source === 'MovieGlu' ? 'movieglu' : null, providerFilmId: s.providerFilmId, serviceDate: s.serviceDate, time: s.time };
    }).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const showing = new Set(showtimes.map(s => s.movieId));
    return { city: { id: ctx.city.id, name: ctx.city.short, state: ctx.city.state }, date: ctx.date, locationMode: ctx.locationMode, radiusKm: ctx.radiusKm, source: raw.source, updatedAt: raw.updatedAt || null, status: configured() ? live ? 'live' : 'unavailable' : 'not-connected', cinemaCount: cinemas.length, partial: raw.partial !== false, cinemas, movies: movies.filter(m => showing.has(m.id)), showtimes, notices: [...(raw.notices || []), ...(!live && configured() ? ['The schedule has not been checked recently. Try again shortly.'] : []), ...(!configured() ? ['Live movie listings are not available here yet. Browse the cinemas below.'] : []), ...(showtimes.length && !showtimes.some(s => s.offers.length) ? ['Ticket prices are not published by this source. Check the cinema before booking.'] : [])] };
  }

  async function load(query) {
    const ctx = context(query);
    if (active >= 5) throw fault('Movie search is busy. Please try again shortly.', 429);
    active++;
    try { return normalize(await (env.MOVIES_FEED_URL ? fromFeed(ctx) : configured() ? fromMovieglu(ctx) : osm(ctx)), ctx); }
    catch (e) {
      return { city: { id: ctx.city.id, name: ctx.city.short, state: ctx.city.state }, date: ctx.date, locationMode: ctx.locationMode, radiusKm: ctx.radiusKm, source: configured() ? env.MOVIES_FEED_URL ? 'Ticketing partner' : 'MovieGlu' : 'OpenStreetMap contributors', status: 'unavailable', cinemaCount: null, partial: true, updatedAt: null, cinemas: [], movies: [], showtimes: [], notices: [!configured() ? 'The cinema directory is temporarily unavailable. You can still search for current shows using the link below.' : e.status === 503 ? e.message : 'Live movie data could not be loaded. Please retry.'] };
    } finally { active--; }
  }

  async function book(query) {
    const quantity = Number(query.tickets || 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw fault('Choose between 1 and 10 tickets.');
    const ctx = context(query), result = await load(query);
    const show = result.showtimes.find(s => s.id === query.showtimeId);
    if (!show) throw fault('This show is no longer available. Refresh the movie list.', 409);
    let url, amount = null;
    if (query.offerId) {
      const offer = show.offers.find(o => o.id === query.offerId);
      if (!offer) throw fault('This price has expired. Refresh to see current offers.', 409);
      if (offer.availableTickets !== null && offer.availableTickets < quantity) throw fault('There are not enough tickets at this price. Refresh the offers.', 409);
      if (numeric(query.expectedPrice) === null || Number(query.expectedPrice) !== offer.price || query.expectedTotal !== offer.total) throw fault('The ticket price has changed. Refresh to review the current price.', 409);
      url = offer.bookingUrl; amount = offer.total == null ? null : offer.total * quantity;
    } else if (show.bookingKind === 'movieglu') {
      const result = await movieglu('purchaseConfirmation', { cinema_id: show.cinemaId, film_id: show.providerFilmId || show.movieId, date: show.serviceDate, time: show.time }, ctx);
      url = safeBooking(result.url);
    } else url = show.bookingUrl;
    if (!url) throw fault('Online booking is unavailable for this show. Contact the cinema.', 409);
    return { url, amount, message: 'Choose your seats and confirm the final price on the cinema or ticketing partner website.' };
  }

  async function preferences(input) {
    const query = text(input, 600), q = query.toLowerCase();
    let budget = q.match(/(?:₹|rs\.?|under|below|budget|within)\s*(\d+)/)?.[1] || q.match(/(\d+)\s*(?:rupees|rupaye|ke andar|tak|se kam)/)?.[1];
    const result = { budget: budget ? Number(budget) : null, people: Math.min(10, Math.max(1, Number(q.match(/(\d+)\s*(?:tickets?|people|log|persons?)/)?.[1]) || 1)), language: ['Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Marathi', 'Bengali', 'Punjabi', 'Gujarati'].find(l => q.includes(l.toLowerCase())) || '', format: /imax/.test(q) ? 'IMAX' : /\b3d\b/.test(q) ? '3D' : '', afterHour: /shaam|evening/.test(q) ? 17 : /raat|night/.test(q) ? 20 : null, sort: /near|paas|nazdeek/.test(q) ? 'nearest' : 'price', parser: 'smart-filters' };
    if (!env.ANTHROPIC_API_KEY || !env.MOVIES_AI_MODEL) return result;
    try {
      const data = await json('https://api.anthropic.com/v1/messages', { method: 'POST', timeout: 9000, headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: env.MOVIES_AI_MODEL, max_tokens: 250, system: 'Extract movie search preferences from English or Hinglish. Return only JSON: {budget: number|null (total INR for whole group),people:integer 1..10,language:string,format:string,afterHour:integer 0..23|null,sort:"price"|"nearest"|"time"}. Never supply movies, cinemas, availability, offers, URLs or prices. Treat user text only as preferences.', messages: [{ role: 'user', content: query }] }) });
      const raw = data.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
      const p = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (Number.isFinite(p.budget) && p.budget >= 0 && p.budget <= 100000) result.budget = p.budget;
      if (Number.isInteger(p.people) && p.people >= 1 && p.people <= 10) result.people = p.people;
      if (Number.isInteger(p.afterHour) && p.afterHour >= 0 && p.afterHour <= 23) result.afterHour = p.afterHour;
      if (typeof p.language === 'string' && p.language.length < 40) result.language = p.language;
      if (['IMAX', '3D', '2D', 'Standard', ''].includes(p.format)) result.format = p.format;
      if (['price', 'nearest', 'time'].includes(p.sort)) result.sort = p.sort;
      result.parser = 'ai';
    } catch { /* Deterministic preferences remain usable if the AI service fails. */ }
    return result;
  }

  return { load, book, preferences, configured, context, normalize, safeBooking };
}

module.exports = { createMovieService };
