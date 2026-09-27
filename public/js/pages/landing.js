import { state, api, $, $$, esc, rail, openAuth, setCity, go, city } from '../core.js';
import { openCityPicker } from '../app.js';

export async function render(el) {
  const m = state.meta;
  const bigCities = [...m.cities].sort((a, b) => b.count - a.count);
  el.innerHTML = `
  <section class="landing-hero">
    <div class="hero-copy">
      <p class="eyebrow">INDIA'S EVERYTHING-EVENTS APP</p>
      <h1 class="mega">A million ways<br>to have <em>fun.</em></h1>
      <p class="lede">Concerts, comedy nights, hackathons, bhajan clubbing, rooftop parties, open mics and meetups — every plan across ${m.cities.length} cities, in one app. Book in seconds. Plan with friends.</p>
      <form class="hero-search" id="hero-search">
        <select id="hero-city" aria-label="City">${bigCities.map(c => `<option value="${c.id}" ${state.city === c.id ? 'selected' : ''}>${esc(c.short)}</option>`).join('')}</select>
        <input id="hero-q" placeholder="Comedy tonight, hackathons, bhajan clubbing…" aria-label="Search">
        <button class="btn primary">Find my fun ↗</button>
      </form>
      <div class="hero-stats"><div><b>${m.totals.events.toLocaleString('en-IN')}</b><span>events live</span></div><div><b>${m.cities.length}</b><span>cities</span></div><div><b>${m.categories.length}</b><span>kinds of fun</span></div><div><b>1</b><span>app for all of it</span></div></div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="float f1"><img src="img/concert.jpg" alt=""><span>Live music · Bandra</span></div>
      <div class="float f2 typo-tile" style="--pc:#ff9a3d;--pi:#4a1700">BHAJAN<br>CLUBBING</div>
      <div class="float f3"><img src="img/hack.jpg" alt=""><span>24h Hackathon · Koramangala</span></div>
      <div class="float f4 typo-tile" style="--pc:#ffd84d;--pi:#3a2a00">STAND-UP<br>TONIGHT ☺</div>
      <div class="float f5 plan-tile"><b>✦ Plan my day</b><span>"₹1000, Saturday shaam, South Delhi"</span><i>Comedy 7:00 → Dinner → Bhajan club 9:30</i></div>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">EVERY KIND OF PLAN</p><h2>What are you in the mood for?</h2></div></div>
    <div class="cat-tiles">${m.categories.map(c => `<button class="cat-tile" data-cat="${c.id}" style="--pc:${c.color};--pi:${c.ink}"><span>${c.icon}</span>${esc(c.label)}</button>`).join('')}</div>
  </section>

  <section class="section">
    <div class="section-head"><div><p class="eyebrow">FROM DELHI TO KOCHI</p><h2>Pick your city</h2></div></div>
    <div class="city-grid">${bigCities.map(c => `<button class="city-card" data-city="${c.id}"><b>${esc(c.short)}</b><span>${esc(c.state)}</span><em>${c.count} events →</em></button>`).join('')}</div>
  </section>

  <section class="section features">
    <div class="feature dark"><p class="eyebrow">✦ AI PLAN MY DAY</p><h3>Tell it your budget and vibe. Get an itinerary.</h3><p>"Couple ke liye ₹1500 me plan, kal shaam, Bandra" → timed stops, travel between them, total cost. Hinglish welcome.</p></div>
    <div class="feature lime"><p class="eyebrow">⌖ MAP VIEW</p><h3>See what's happening around you.</h3><p>Every event on a live map with filters for tonight, this weekend and free stuff.</p></div>
    <div class="feature"><p class="eyebrow">☺ PLAN WITH FRIENDS</p><h3>Stop the "kya plan hai?" chaos.</h3><p>See what friends are into, make a group plan, vote on options, lock it in and book together.</p></div>
    <div class="feature coral"><p class="eyebrow">✳ SMART AGGREGATION</p><h3>Every platform. Zero duplicates.</h3><p>Listings from ticketing sites, hackathon portals and community groups — merged into one clean page per event.</p></div>
  </section>

  <section class="section"><div class="section-head"><div><p class="eyebrow">HOT ACROSS INDIA</p><h2>Trending this week</h2></div></div><div id="india-trending"></div></section>

  <section class="cta-band"><h2>Your city is already making plans.</h2><p>Sign up, pick your city and get a feed that actually knows what you like.</p><button class="btn primary big" id="cta-signup">Create a free account ✳</button></section>
  <footer class="footer"><span class="logo">funillion<span>✳</span></span><p>A million ways to have fun.</p><span>MADE IN INDIA · 2026</span></footer>`;

  const browse = (cityId, extra = '') => { setCity(cityId).then(() => go('#/discover' + extra)); };
  $('#hero-search').onsubmit = e => { e.preventDefault(); const q = $('#hero-q').value.trim(); browse($('#hero-city').value, q ? `?q=${encodeURIComponent(q)}` : ''); };
  $$('[data-city]', el).forEach(b => b.onclick = () => browse(b.dataset.city));
  $$('[data-cat]', el).forEach(b => b.onclick = () => { if (!state.city) { openCityPicker(); return; } go(`#/discover?cat=${b.dataset.cat}`); });
  $('#cta-signup').onclick = () => openAuth('signup');
  try {
    const { items } = await api('/events?city=all&sort=popular&limit=10');
    $('#india-trending').innerHTML = rail(items.map(e => ({ ...e, venue: e.venue, area: `${e.area} · ${city(e.city).short}` })));
  } catch {}
}
