import { state, api, $, $$, esc, money, priceLabel, cat, city, relDay, fmtTime, loading } from '../core.js';
import { openCityPicker } from '../app.js';

const f = { when: 'week', cat: 'all', price: 'all' };
export async function render(el) {
  if (!state.city) { openCityPicker(); el.innerHTML = '<div class="empty"><h3>Pick a city to see the map</h3></div>'; return; }
  const c = city(state.city);
  el.className = 'full-bleed';
  el.innerHTML = `
  <div class="map-page">
    <aside class="map-side">
      <p class="eyebrow">MAP VIEW</p><h1>${esc(c.short)} tonight & beyond</h1>
      <div class="seg" id="when">${[['today', 'Today'], ['tomorrow', 'Tomorrow'], ['weekend', 'Weekend'], ['week', '7 days'], ['all', 'All']].map(([v, l]) => `<button data-v="${v}" class="${f.when === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="two"><select id="mcat" aria-label="Category"><option value="all">All categories</option>${state.meta.categories.map(k => `<option value="${k.id}">${k.icon} ${esc(k.label)}</option>`).join('')}</select>
      <select id="mprice" aria-label="Price"><option value="all">Any price</option><option value="free">Free</option><option value="500">Under ₹500</option><option value="1000">Under ₹1,000</option></select></div>
      <button class="btn ghost full" id="near">◎ Sort by distance from me</button>
      <p class="muted small" id="mcount"></p>
      <div class="map-list" id="mlist"></div>
    </aside>
    <div id="bigmap" class="bigmap"></div>
  </div>`;
  $('#mcat').value = f.cat; $('#mprice').value = f.price;
  if (!window.L) { $('#bigmap').innerHTML = '<div class="empty"><h3>Map needs internet</h3><p>Leaflet & OpenStreetMap tiles load from the web.</p></div>'; }
  const map = window.L ? L.map('bigmap', { zoomControl: true }).setView([c.lat, c.lng], 12) : null;
  map && L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const layer = map ? L.layerGroup().addTo(map) : null;
  const markers = new Map();
  let me = null, items = [];

  const km = (a, b) => { const R = 6371, r = x => x * Math.PI / 180; const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
  const draw = () => {
    if (me) items.forEach(e => e.dist = km(me, e)), items.sort((a, b) => a.dist - b.dist);
    $('#mcount').textContent = `${items.length} events on the map`;
    $('#mlist').innerHTML = items.length ? items.map(e => { const k = cat(e.category); return `<a class="map-item" href="#/event/${e.id}" data-id="${e.id}"><span class="dot" style="--pc:${k.color};--pi:${k.ink}">${k.icon}</span><div><b>${esc(e.title)}</b><small>${relDay(e.start)} · ${fmtTime(e.start)} · ${esc(e.area)}${e.dist != null ? ` · ${e.dist < 1 ? Math.round(e.dist * 1000) + ' m' : e.dist.toFixed(1) + ' km'} away` : ''}</small></div><em>${priceLabel(e, true)}</em></a>`; }).join('') : '<div class="empty small"><p>No events match — try All dates.</p></div>';
    if (!map) return;
    layer.clearLayers(); markers.clear();
    const bounds = [];
    for (const e of items) {
      const k = cat(e.category);
      const m = L.marker([e.lat, e.lng], { icon: L.divIcon({ className: 'pin', html: `<span style="--pc:${k.color};--pi:${k.ink}"><i>${k.icon}</i></span>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -30] }) })
        .bindPopup(`<div class="pop"><small>${esc(k.label.toUpperCase())}</small><b>${esc(e.title)}</b><span>${relDay(e.start)} · ${fmtTime(e.start)}</span><span>${esc(e.venue)}, ${esc(e.area)}</span><span>${priceLabel(e)}${e.friendCount ? ` · ${e.friendCount} friend${e.friendCount > 1 ? 's' : ''} interested` : ''}</span><a href="#/event/${e.id}">View & book →</a></div>`);
      m.addTo(layer); markers.set(e.id, m); bounds.push([e.lat, e.lng]);
    }
    if (me) { L.circleMarker([me.lat, me.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#2f6bff', fillOpacity: 1 }).addTo(layer).bindPopup('You are here'); bounds.push([me.lat, me.lng]); }
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  };
  const load = async () => {
    loading($('#mlist'));
    ({ items } = await api(`/map?city=${state.city}&when=${f.when}&cat=${f.cat}&price=${f.price}&sort=date`));
    draw();
  };
  $$('#when button').forEach(b => b.onclick = () => { f.when = b.dataset.v; $$('#when button').forEach(x => x.classList.toggle('on', x === b)); load(); });
  $('#mcat').onchange = e => { f.cat = e.target.value; load(); };
  $('#mprice').onchange = e => { f.price = e.target.value; load(); };
  $('#near').onclick = () => {
    if (!navigator.geolocation) return;
    $('#near').textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(p => {
      me = { lat: p.coords.latitude, lng: p.coords.longitude };
      if (km(me, c) > 60) { $('#near').textContent = `You seem to be outside ${c.short} — showing distance anyway`; }
      else $('#near').textContent = '◎ Sorted by distance';
      draw();
    }, () => { $('#near').textContent = 'Location blocked — enable it in your browser'; }, { timeout: 8000 });
  };
  $('#mlist').addEventListener('mouseover', e => { const it = e.target.closest('[data-id]'); if (it && markers.get(it.dataset.id)) markers.get(it.dataset.id).openPopup(); });
  await load();
  setTimeout(() => map?.invalidateSize(), 100);
  return () => map?.remove();
}
