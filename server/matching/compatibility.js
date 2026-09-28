// Deterministic social compatibility engine. The LLM never touches this — ranking is pure,
// auditable arithmetic so results are reproducible and explainable.
//   compatibility_score = 0.30*interest_similarity + 0.20*availability_overlap + 0.20*distance_score
//                        + 0.15*activity_preference + 0.10*community_overlap + 0.05*reliability_score
// Weights are configurable via env vars (fall back to the defaults above) so they can be tuned
// without a code change.
const { jaccard } = require('../util');
const geo = require('../geo');
const availability = require('../availability');
const safety = require('../safety');
const { INTEREST_LABEL, RELATED_INTERESTS } = require('../interests');

const DEFAULTS = { interest: 0.30, availability: 0.20, distance: 0.20, activity: 0.15, community: 0.10, reliability: 0.05 };
const envFloat = (name, fallback) => { const v = parseFloat(process.env[name]); return Number.isFinite(v) ? v : fallback; };
const WEIGHTS = {
  interest: envFloat('MATCH_WEIGHT_INTEREST', DEFAULTS.interest),
  availability: envFloat('MATCH_WEIGHT_AVAILABILITY', DEFAULTS.availability),
  distance: envFloat('MATCH_WEIGHT_DISTANCE', DEFAULTS.distance),
  activity: envFloat('MATCH_WEIGHT_ACTIVITY', DEFAULTS.activity),
  community: envFloat('MATCH_WEIGHT_COMMUNITY', DEFAULTS.community),
  reliability: envFloat('MATCH_WEIGHT_RELIABILITY', DEFAULTS.reliability),
};

// util.jaccard treats "both empty" as identical (1.0), which is right for text dedup but wrong
// here — two people with no stated interests share no signal, not perfect overlap.
function interestSimilarity(a, b) { return (a || []).length || (b || []).length ? jaccard(a || [], b || []) : 0; }

// No specific window asked for -> neutral. Candidate never stated any availability -> neutral
// (unknown isn't "unavailable"). Otherwise 1 if their stated window covers the request, else low.
function availabilityOverlapScore(db, candidateId, ctx) {
  if (!ctx?.dateKey) return 0.5;
  const ov = availability.overlaps(db, candidateId, ctx.dateKey, ctx.fromHour ?? 0, ctx.toHour ?? 30);
  return ov === null ? 0.5 : ov ? 1 : 0.1;
}

// Neither side has picked an area yet -> neutral (don't punish people for not onboarding geo).
function distanceScoreFor(viewer, candidate, radiusKm = 5) {
  const a = geo.userPoint(viewer), b = geo.userPoint(candidate);
  if (!a || !b) return { score: 0.5, km: null };
  const km = geo.approxDistanceKm(a, b);
  return { score: Math.max(0, Math.min(1, 1 - km / Math.max(1, radiusKm))), km };
}

// Does the candidate actually like this activity — explicit interest, or a recency-weighted
// history of engaging with events in that category (mirrors feed.js's affinity decay).
function activityPreferenceScore(db, candidate, activityId) {
  if (!activityId) return 0.5;
  const acceptedIds = [activityId, ...(RELATED_INTERESTS[activityId] || [])];
  if ((candidate.interests || []).some(i => acceptedIds.includes(i))) return 1;
  const now = Date.now();
  let weight = 0;
  for (const it of db.interactions) {
    if (it.userId !== candidate.id || !it.eventId) continue;
    const ev = db.events[it.eventId];
    if (!ev || ev.category !== activityId) continue;
    weight += Math.pow(0.5, (now - new Date(it.at)) / 86400000 / 14);
  }
  return Math.max(0, Math.min(1, weight / 3));
}

function communitiesOf(db, userId) {
  return new Set(Object.values(db.communities).filter(c => c.members.some(m => m.userId === userId)).map(c => c.id));
}
function communityOverlapScore(db, aId, bId) {
  const A = communitiesOf(db, aId), B = communitiesOf(db, bId);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Completed vs. no-show/late-cancelled plans, Laplace-smoothed so a brand-new user starts at a
// fair 0.75 instead of being punished for having no history yet.
function reliabilityFor(db, userId) {
  let good = 0, bad = 0;
  for (const it of db.interactions) {
    if (it.userId !== userId) continue;
    if (it.type === 'plan_completed') good++;
    else if (it.type === 'plan_no_show' || it.type === 'plan_cancelled_late') bad++;
  }
  return { score: (good + 1.5) / (good + bad + 2), sampleSize: good + bad };
}

function sharedInterestReason(a, b) {
  const shared = (a || []).filter(x => (b || []).includes(x)).map(id => INTEREST_LABEL[id] || id);
  return shared.length ? `Both interested in ${shared.slice(0, 2).join(' & ')}` : null;
}

// ctx: { activityId, dateKey, fromHour, toHour, radiusKm }
function scoreCandidate(db, viewer, candidate, ctx = {}) {
  const interest = interestSimilarity(viewer.interests, candidate.interests);
  const avail = availabilityOverlapScore(db, candidate.id, ctx);
  const { score: distance, km } = distanceScoreFor(viewer, candidate, ctx.radiusKm);
  const activity = activityPreferenceScore(db, candidate, ctx.activityId);
  const community = communityOverlapScore(db, viewer.id, candidate.id);
  const reliability = reliabilityFor(db, candidate.id);

  const score = WEIGHTS.interest * interest + WEIGHTS.availability * avail + WEIGHTS.distance * distance +
    WEIGHTS.activity * activity + WEIGHTS.community * community + WEIGHTS.reliability * reliability.score;

  const reasons = [];
  const ir = sharedInterestReason(viewer.interests, candidate.interests); if (ir) reasons.push(ir);
  if (avail === 1) reasons.push('Free at the same time');
  if (km != null) reasons.push(geo.distanceLabel(km));
  if (ctx.activityId && activity >= 0.66) reasons.push(`Into ${INTEREST_LABEL[ctx.activityId] || ctx.activityId}`);
  if (community > 0) reasons.push('Shares a community with you');
  if (reliability.sampleSize >= 2 && reliability.score >= 0.85) reasons.push('Reliable — usually follows through on plans');

  // Never leak raw sub-scores, interaction history or anything beyond a rounded headline number + reasons.
  return { user_id: candidate.id, compatibility_score: Math.round(score * 100) / 100, reasons: reasons.slice(0, 3) };
}

function rankCandidates(db, viewer, pool, ctx = {}, limit = 20) {
  return pool
    .filter(u => u.id !== viewer.id && u.discoverable !== false && !safety.isBlocked(db, viewer.id, u.id))
    .map(u => scoreCandidate(db, viewer, u, ctx))
    .sort((a, b) => b.compatibility_score - a.compatibility_score)
    .slice(0, limit);
}

module.exports = { WEIGHTS, scoreCandidate, rankCandidates, interestSimilarity, distanceScoreFor, availabilityOverlapScore, activityPreferenceScore, communityOverlapScore, reliabilityFor };
