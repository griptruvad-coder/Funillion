// Privacy-preserving location: users pick an area (not a GPS pin), matching runs on that area's
// centroid plus a small per-user jitter, and only rounded distance labels ever reach the client —
// never raw coordinates or anything precise enough to pinpoint a home address.
const crypto = require('crypto');
const { CITIES } = require('./catalog');
const { haversineKm } = require('./util');

function findArea(cityId, areaName) {
  const city = CITIES.find(c => c.id === cityId);
  return (city && city.areas.find(a => a.name === areaName)) || null;
}

// Deterministic per-user offset (~±0.6km) so two people who picked the same area don't collapse
// onto one point (which would make "0.0 km away" identify them) — stable across requests.
function jitter(userId) {
  const h = crypto.createHash('md5').update(String(userId)).digest();
  return { jx: (h[0] / 255 - 0.5) * 0.012, jy: (h[1] / 255 - 0.5) * 0.012 };
}

// A user's private approximate point. Never send this object to a client — only distances/labels
// derived from it.
function userPoint(user) {
  if (!user) return null;
  const city = CITIES.find(c => c.id === user.city);
  if (!city) return null;
  const area = (user.homeArea && findArea(user.city, user.homeArea)) || city.areas[0];
  if (!area) return null;
  const { jx, jy } = jitter(user.id);
  return { lat: area.lat + jx, lng: area.lng + jy };
}

function approxDistanceKm(a, b) {
  return a && b ? haversineKm(a, b) : null;
}

// Coarse, human-readable bucket — never a precise figure.
function distanceLabel(km) {
  if (km == null) return null;
  if (km < 0.5) return 'Very close by';
  if (km < 1) return '< 1 km away';
  return `~${km < 5 ? Math.round(km * 2) / 2 : Math.round(km)} km away`;
}

module.exports = { findArea, userPoint, approxDistanceKm, distanceLabel };
