import { state, api, esc, money, city, $, toast, fmtTime, dayKey, loading } from '../core.js';
import { openCityPicker } from '../app.js';

export function render(el) {
  let alive = true, version = 0, data = null, location = null;
  const cityId = state.city || 'delhi', currentCity = city(cityId);
  const filters = { movie: '', language: '', format: '', budget: '', people: 1, sort: 'value', afterHour: null };
  const today = dayKey(new Date()), lastDay = dayKey(Date.now() + 7 * 86400000);
  el.innerHTML = `
    <section class="movie-hero section">
      <div><p class="eyebrow">THE BIG SCREEN, A BETTER PLAN</p><h1>Movie night,<br><em>sorted.</em></h1><p class="lede">Find films actually showing nearby. Compare the ticket offers available for your date, language and screen.</p>
      <button class="btn primary" id="movie-city">⌖ ${esc(currentCity.short)}, ${esc(currentCity.state)} ▾</button></div>
      <div class="movie-marquee" aria-hidden="true"><span>NOW<br>SHOWING</span><b>▣</b><small>YOUR CITY. YOUR SCREEN.</small></div>
    </section>
    <section class="section movie-workspace">
      <form id="movie-controls" class="movie-controls">
        <label>Date<input id="movie-date" type="date" value="${today}" min="${today}" max="${lastDay}" required></label>
        <label>Nearby radius<select id="movie-radius">${[5, 10, 15, 25, 50].map(n => `<option value="${n}" ${n === 15 ? 'selected' : ''}>${n} km</option>`).join('')}</select></label>
        <button class="btn ghost" type="button" id="movie-location">⌖ Use my location</button><button class="btn primary" type="submit">Find shows ↗</button>
      </form>
      <p class="muted small" id="movie-location-note">Distances are from ${esc(currentCity.short)} city centre. Use your location for nearby results; this shares coordinates with the cinema data provider.</p>
      <div id="movie-status" role="status" aria-live="polite"></div>
      <div class="movie-stats" id="movie-stats"></div>
      <div class="movie-ai"><div><b>✦ Help me choose</b><p>Try “2 tickets, Hindi, shaam ko, total ₹800 ke andar”.</p></div><form id="movie-ai-form"><label class="sr-only" for="movie-request">Describe your movie plan</label><input id="movie-request" maxlength="600" placeholder="Your budget, language and movie-night plans…" required><button class="btn dark" id="movie-ai-go">Find my match ✦</button></form><p class="small" id="movie-ai-note" role="status">Smart picks balance listed ticket price and distance. Your filters stay in control.</p></div>
      <details class="movie-selector" open><summary><span>Now showing nearby</span><small id="movie-title-count">Choose a movie below</small></summary>
        <label>Movie<select id="movie-select"><option value="">Loading current movies…</option></select></label>
        <div class="movie-posters" id="movie-posters"></div>
      </details>
      <div class="movie-filters">
        <label>Language<select id="movie-language"><option value="">All languages</option></select></label>
        <label>Screen<select id="movie-format"><option value="">All formats</option></select></label>
        <label>Tickets<input id="movie-people" type="number" min="1" max="10" value="1"></label>
        <label>Total budget (₹)<input id="movie-budget" type="number" min="0" placeholder="Any budget"></label>
        <label>Sort by<select id="movie-sort"><option value="value">Smart pick</option><option value="price">Listed ticket price</option><option value="nearest">Nearest cinema</option><option value="time">Next show</option></select></label>
      </div>
      <div id="movie-results"></div>
      <details class="movie-cinema-directory"><summary id="cinema-summary">Nearby cinemas</summary><div id="cinema-directory"></div></details>
      <p class="fine" id="movie-source"></p>
    </section>`;
  const q = selector => $(selector, el);
  q('#movie-city').onclick = openCityPicker;
  const request = () => ({ city: cityId, date: q('#movie-date').value, radiusKm: q('#movie-radius').value, ...(location || {}) });

  async function load() {
    const stamp = ++version; data = null;
    loading(q('#movie-results'), 'Checking nearby cinemas and current schedules…');
    q('#movie-status').textContent = ''; q('#movie-stats').innerHTML = ''; q('#movie-posters').innerHTML = '';
    q('#movie-select').innerHTML = '<option value="">Loading current movies…</option>'; q('#movie-select').disabled = true;
    q('#cinema-directory').innerHTML = ''; q('#movie-source').textContent = '';
    q('#cinema-summary').textContent = 'Nearby cinemas';
    try {
      const result = await api('/movies?' + new URLSearchParams(request()));
      if (!alive || stamp !== version) return;
      data = result;
      q('#movie-status').innerHTML = result.notices.map(n => `<p class="movie-notice">${esc(n)}</p>`).join('');
      q('#movie-stats').innerHTML = `<div><b>${result.cinemaCount ?? '—'}</b><span>cinemas found within ${result.radiusKm} km</span></div><div><b>${result.status === 'live' ? result.movies.length : '—'}</b><span>movies with upcoming shows</span></div><div><b>${result.status === 'live' ? result.showtimes.length : '—'}</b><span>shows on your chosen date</span></div>`;
      q('#movie-select').innerHTML = '<option value="">All movies with shows</option>' + result.movies.map(m => `<option value="${esc(m.id)}">${esc(m.title)}</option>`).join('');
      q('#movie-select').disabled = !result.movies.length;
      if (!result.movies.some(m => m.id === filters.movie)) filters.movie = '';
      q('#movie-select').value = filters.movie;
      q('#movie-title-count').textContent = result.status === 'live' ? `${result.movies.length} movies · ${result.date}` : 'Live movie list unavailable';
      q('#movie-posters').innerHTML = result.movies.map(m => `<button class="movie-poster ${filters.movie === m.id ? 'selected' : ''}" type="button" data-movie="${esc(m.id)}" aria-pressed="${filters.movie === m.id}">${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="movie-poster-art" aria-hidden="true">▣</span>'}<b>${esc(m.title)}</b><small>${esc(m.rating || 'View showtimes')} ↗</small></button>`).join('');
      const options = (key, target, label) => {
        const vals = [...new Set(result.showtimes.map(s => s[key]).filter(Boolean))].sort();
        q(target).innerHTML = `<option value="">${label}</option>` + vals.map(v => `<option>${esc(v)}</option>`).join('');
        if (filters[key] && !vals.includes(filters[key])) filters[key] = '';
        q(target).value = filters[key];
      };
      options('language', '#movie-language', 'All languages'); options('format', '#movie-format', 'All formats');
      q('#cinema-summary').textContent = `${result.cinemaCount ?? '—'} cinemas found nearby${result.partial ? ' · coverage may be incomplete' : ''}`;
      q('#cinema-directory').innerHTML = result.cinemas.length ? result.cinemas.map(c => `<div class="movie-cinema-row"><div><b>${esc(c.name)}</b><p>${esc(c.address)}</p></div><a class="link" target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.lat},${c.lng}`)}">${c.distanceKm} km · Directions ↗</a><a class="link" target="_blank" rel="noopener noreferrer" href="https://www.google.com/search?q=${encodeURIComponent(`${c.name} ${currentCity.short} movie showtimes`)}">Current shows ↗</a></div>`).join('') : '<p class="muted">No cinema directory results are available for this search.</p>';
      q('#movie-source').textContent = `Source: ${result.source}. ${result.updatedAt ? `Checked ${new Date(result.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.` : ''} ${result.source === 'OpenStreetMap contributors' ? '© OpenStreetMap contributors · openstreetmap.org/copyright.' : ''}`;
      draw();
    } catch (error) {
      if (!alive || stamp !== version) return;
      q('#movie-results').innerHTML = `<div class="empty"><h3>Movie search could not load</h3><p>${esc(error.message)}</p><button class="btn" id="movie-retry">Try again</button></div>`;
      q('#movie-retry').onclick = load;
    }
  }

  function draw() {
    if (!data || !alive) return;
    const cinemas = new Map(data.cinemas.map(c => [c.id, c])), movies = new Map(data.movies.map(m => [m.id, m]));
    const budget = filters.budget === '' ? null : Number(filters.budget), people = filters.people;
    const shows = data.showtimes.filter(s => Date.parse(s.startsAt) > Date.now() && (!filters.movie || s.movieId === filters.movie) && (!filters.language || s.language.toLowerCase() === filters.language.toLowerCase()) && (!filters.format || s.format.toLowerCase().includes(filters.format.toLowerCase())) && (filters.afterHour == null || Number(new Date(s.startsAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' })) >= filters.afterHour)).map(s => ({ ...s, offers: s.offers.filter(o => Date.parse(o.expiresAt) > Date.now() && Date.now() - Date.parse(o.checkedAt) <= 15 * 60000 && (o.availableTickets == null || o.availableTickets >= people) && (budget == null || o.total !== null && o.total * people <= budget)).sort((a, b) => a.price - b.price) })).filter(s => budget == null || s.offers.length);
    const priced = shows.flatMap(s => s.offers.map(o => ({ s, o }))), minPrice = priced.length ? Math.min(...priced.map(({ o }) => o.price)) : null;
    const maxPrice = Math.max(1, ...priced.map(({ o }) => o.price)), maxDistance = Math.max(1, data.radiusKm);
    const showPrice = s => s.offers.length ? s.offers[0].price : Infinity;
    const score = s => showPrice(s) === Infinity ? Infinity : .65 * showPrice(s) / maxPrice + .35 * cinemas.get(s.cinemaId).distanceKm / maxDistance;
    shows.sort((a, b) => (filters.sort === 'nearest' ? cinemas.get(a.cinemaId).distanceKm - cinemas.get(b.cinemaId).distanceKm : filters.sort === 'time' ? a.startsAt.localeCompare(b.startsAt) : filters.sort === 'price' ? showPrice(a) - showPrice(b) : score(a) - score(b)) || a.startsAt.localeCompare(b.startsAt));
    const smartId = [...shows].sort((a, b) => score(a) - score(b))[0]?.id;
    q('#movie-posters').querySelectorAll('[data-movie]').forEach(b => { const on = b.dataset.movie === filters.movie; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', String(on)); });
    q('#movie-results').innerHTML = shows.length ? `<div class="section-head"><div><p class="eyebrow">${filters.movie ? esc(movies.get(filters.movie)?.title) : 'YOUR NEARBY OPTIONS'}</p><h2>${shows.length} upcoming shows</h2></div></div><p class="muted small">Prices are per ticket in INR. Group totals use ${people} ticket${people > 1 ? 's' : ''}. Budget filters include only offers with known fees. Lowest price means lowest listed ticket among these results; seat class and checkout fees can differ.</p><div class="movie-shows">${shows.map(s => {
      const c = cinemas.get(s.cinemaId), m = movies.get(s.movieId);
      return `<article class="movie-show"><div class="movie-show-main"><div class="movie-show-heading"><span class="movie-show-time">${esc(fmtTime(s.startsAt))}<small>${esc(dayKey(s.startsAt))}</small></span><div><h3>${esc(m.title)}</h3><p><b>${esc(c.name)}</b> · ${c.distanceKm} km</p><p class="muted small">${esc(c.address)}</p><div class="chips wrap"><span class="chip">${esc(s.language || 'Language on listing')}</span><span class="chip">${esc(s.format)}</span>${s.id === smartId && s.offers.length ? '<span class="movie-badge">✦ Smart pick · price + distance</span>' : ''}</div></div></div></div><div class="movie-offers">${s.offers.length ? s.offers.map(o => `<div class="movie-offer"><div><span class="small">${esc(o.provider)} · ${esc(o.seatClass)}</span><strong>${money(o.price)} <small>/ ticket${o.price === minPrice ? ' · lowest listed' : ''}</small></strong><p class="small muted">${o.total == null ? `From ${money(o.price * people)} for ${people} · checkout fees extra` : `${money(o.total * people)} for ${people}, including ${o.feesIncluded ? 'fees' : money(o.fees || 0) + ' fees per ticket'}`}</p></div><button class="btn ${o.price === minPrice ? 'primary' : 'ghost'}" data-book="${esc(s.id)}" data-offer="${esc(o.id)}">Book ↗</button></div>`).join('') : `<div class="movie-offer"><div><strong>Price on partner site</strong><p class="small muted">Check seats and ticket prices before paying.</p></div>${s.bookingKind || s.bookingUrl ? `<button class="btn primary" data-book="${esc(s.id)}">View tickets ↗</button>` : '<span class="small muted">Contact cinema</span>'}</div>`}</div></article>`;
    }).join('')}</div>` : `<div class="empty"><h3>${data.status === 'not-connected' ? 'Current movie listings are coming soon' : data.status === 'unavailable' ? 'The live schedule is unavailable' : data.showtimes.length ? 'No shows match these filters' : 'No upcoming shows found for this date'}</h3><p>${data.showtimes.length ? 'Try another movie, language, screen or budget.' : 'Browse nearby cinemas below or check current shows on Google.'}</p><a class="btn primary" target="_blank" rel="noopener noreferrer" href="https://www.google.com/search?q=${encodeURIComponent(`movies showtimes ${currentCity.short} ${currentCity.state} ${q('#movie-date').value}`)}">Check current shows ↗</a> <button class="btn ghost" id="movie-clear">Reset filters</button></div>`;
    q('#movie-clear')?.addEventListener('click', () => { filters.movie = ''; filters.language = ''; filters.format = ''; filters.budget = ''; filters.afterHour = null; sync(); draw(); });
  }

  function sync() { for (const [key, id] of Object.entries({ movie: 'select', language: 'language', format: 'format', budget: 'budget', people: 'people', sort: 'sort' })) q(`#movie-${id}`).value = filters[key]; }
  el.addEventListener('click', async event => {
    const movie = event.target.closest('[data-movie]');
    if (movie) { filters.movie = movie.dataset.movie; sync(); draw(); q('#movie-results').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    const button = event.target.closest('[data-book]');
    if (!button || button.disabled) return;
    button.disabled = true; button.textContent = 'Checking…';
    try {
      const offer = data?.showtimes.find(s => s.id === button.dataset.book)?.offers.find(o => o.id === button.dataset.offer);
      const result = await api('/movies/book', { method: 'POST', body: { ...request(), showtimeId: button.dataset.book, offerId: button.dataset.offer || null, tickets: filters.people, expectedPrice: offer?.price, expectedTotal: offer?.total } });
      if (alive) window.location.assign(result.url);
    } catch (error) { if (alive) { toast(error.message, 'error'); await load(); } }
    finally { if (alive) { button.disabled = false; button.textContent = 'Book ↗'; } }
  });
  for (const [key, id] of Object.entries({ movie: 'select', language: 'language', format: 'format', budget: 'budget', people: 'people', sort: 'sort' })) q(`#movie-${id}`).addEventListener('change', e => { filters[key] = key === 'people' ? Math.max(1, Math.min(10, Number(e.target.value) || 1)) : e.target.value; sync(); draw(); });
  q('#movie-controls').onsubmit = e => { e.preventDefault(); load(); };
  q('#movie-radius').onchange = load;
  q('#movie-date').onchange = load;
  q('#movie-location').onclick = () => {
    if (!navigator.geolocation) return toast('Your browser does not support location.', 'error');
    q('#movie-location').disabled = true;
    navigator.geolocation.getCurrentPosition(pos => {
      if (!alive) return;
      location = { lat: Number(pos.coords.latitude.toFixed(4)), lng: Number(pos.coords.longitude.toFixed(4)) };
      q('#movie-location-note').textContent = 'Distances are from your location. Your location is shared with the cinema data provider for this search.';
      q('#movie-location').disabled = false; q('#movie-location').textContent = '⌖ Update my location'; load();
    }, () => { if (alive) { q('#movie-location').disabled = false; toast('Location unavailable. Using city centre.', 'error'); } }, { timeout: 12000, maximumAge: 60000 });
  };
  q('#movie-ai-form').onsubmit = async e => {
    e.preventDefault(); const button = q('#movie-ai-go'); button.disabled = true; button.textContent = 'Understanding…';
    try {
      const p = await api('/movies/preferences', { method: 'POST', body: { query: q('#movie-request').value } });
      if (!alive) return;
      filters.budget = p.budget ?? ''; filters.people = p.people; filters.sort = p.sort; filters.afterHour = p.afterHour;
      // Only use filters that exist in this live schedule; show a clear message for missing ones.
      const matchOption = (target, value) => [...q(target).options].find(o => o.value && o.value.toLowerCase().includes(value.toLowerCase()))?.value;
      filters.language = p.language ? matchOption('#movie-language', p.language) || '' : '';
      filters.format = p.format ? matchOption('#movie-format', p.format) || '' : '';
      const missing = [p.language && !filters.language && p.language, p.format && !filters.format && p.format].filter(Boolean);
      q('#movie-ai-note').textContent = `${p.parser === 'ai' ? 'AI' : 'Smart filters'} understood: ${p.people} ticket(s)${p.budget != null ? `, total budget ${money(p.budget)}` : ''}${p.afterHour != null ? `, after ${p.afterHour}:00 IST` : ''}.${missing.length ? ` No ${missing.join(' / ')} option is available in the current schedule; those filters were not applied.` : ''} Picks use the live results below.`;
      sync(); draw();
    } catch (error) { if (alive) toast(error.message, 'error'); }
    finally { if (alive) { button.disabled = false; button.textContent = 'Find my match ✦'; } }
  };
  load();
  // Re-evaluate expiring prices without holding stale offers on screen.
  const timer = setInterval(() => { if (data?.status === 'live' && Date.now() - Date.parse(data.updatedAt) > 15 * 60000) load(); else draw(); }, 30000);
  return () => { alive = false; version++; clearInterval(timer); };
}
