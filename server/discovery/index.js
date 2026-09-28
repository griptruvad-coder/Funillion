// Smart Discovery Feed + "I'm Free". Both browse the same pool (open plans, discoverable people,
// communities) through the compatibility engine — discovery is looking, "I'm Free" is one tap
// that turns a match into an actual plan. No filler: a section with nothing genuinely matching
// comes back empty rather than padded with unrelated content.
const { istDayKey, addDaysKey, istHour, istISO } = require('../util');
const nlp = require('../nlp');
const geo = require('../geo');
const safety = require('../safety');
const matching = require('../matching/compatibility');
const availability = require('../availability');
const plansService = require('../plans/service');
const auth = require('../auth');
const { INTEREST_LABEL } = require('../interests');
const feed = require('../feed');

// ---------------------------------------------------------------- shared scoring

function planCard(db, viewer, plan) {
  const interest = matching.interestSimilarity(viewer.interests, plan.interests);
  const activity = matching.activityPreferenceScore(db, viewer, plan.activityType);
  const ctx = plansService.matchContext(plan);
  const avail = matching.availabilityOverlapScore(db, viewer.id, ctx);
  const viewerPt = geo.userPoint(viewer);
  const planPt = plan.areaLat != null ? { lat: plan.areaLat, lng: plan.areaLng } : null;
  const km = viewerPt && planPt ? geo.approxDistanceKm(viewerPt, planPt) : null;
  const distance = km == null ? 0.5 : Math.max(0, Math.min(1, 1 - km / Math.max(1, plan.radiusKm || 5)));
  const freshness = Math.max(0, 1 - (Date.now() - new Date(plan.createdAt)) / (72 * 3600000));
  const recommendation_score = interest + activity * 0.6 + distance + avail + freshness * 0.4;

  const reasons = [];
  const shared = (viewer.interests || []).filter(i => plan.interests.includes(i)).map(i => INTEREST_LABEL[i] || i);
  if (shared.length) reasons.push(`You're both into ${shared.slice(0, 2).join(' & ')}`);
  if (avail === 1) reasons.push('Fits a time you said you\'re free');
  if (km != null) reasons.push(geo.distanceLabel(km));
  if (!reasons.length) reasons.push(`New ${INTEREST_LABEL[plan.activityType] || 'plan'} nearby`);

  return {
    id: plan.id, title: plan.title, activityType: plan.activityType, startTime: plan.startTime, endTime: plan.endTime,
    budgetPerPerson: plan.budgetPerPerson, interestedCount: plansService.acceptedCount(plan), maxParticipants: plan.maxParticipants,
    distanceLabel: km != null ? geo.distanceLabel(km) : null, recommendation_score: Math.round(recommendation_score * 100) / 100,
    reasons: reasons.slice(0, 2), creator: auth.publicUser(db.users[plan.creatorId]),
  };
}

function openPlansFor(db, viewer) {
  plansService.sweep(db);
  return Object.values(db.plans).filter(p =>
    (plansService.OPEN_STATUSES.has(p.status) || p.status === 'CONFIRMED') &&
    plansService.acceptedCount(p) < p.maxParticipants &&
    p.visibility !== 'private' && (p.visibility !== 'verified_only' || viewer.verified) &&
    (p.visibility !== 'community_only' || plansService.inCommunity(db, p.communityId, viewer.id)) &&
    p.creatorId !== viewer.id && !p.participants.some(x => x.userId === viewer.id) &&
    !safety.isBlocked(db, viewer.id, p.creatorId) && p.city === viewer.city);
}

function communityCard(viewer, community) {
  const interest = matching.interestSimilarity(viewer.interests, community.interestTags);
  const recentPosts = community.posts.filter(p => Date.now() - new Date(p.createdAt).getTime() < 7 * 86400000).length;
  const recommendation_score = interest + Math.min(1, recentPosts / 5) * 0.3;
  const shared = (viewer.interests || []).filter(i => community.interestTags.includes(i)).map(i => INTEREST_LABEL[i] || i);
  return {
    id: community.id, name: community.name, description: community.description, icon: community.icon,
    memberCount: community.members.length, joined: community.members.some(m => m.userId === viewer.id),
    recommendation_score: Math.round(recommendation_score * 100) / 100,
    reasons: shared.length ? [`Matches your interest in ${shared[0]}`] : [],
  };
}

// ---------------------------------------------------------------- GET /discover/feed

function feedFor(db, viewer) {
  const planCards = openPlansFor(db, viewer).map(p => planCard(db, viewer, p)).sort((a, b) => b.recommendation_score - a.recommendation_score);
  const today = istDayKey(new Date());
  const nowH = istHour(new Date());
  const wk = new Set(feed.weekendKeys());
  const tonight = planCards.filter(c => istDayKey(c.startTime) === today && istHour(c.startTime) >= Math.min(nowH, 16));
  const weekend = planCards.filter(c => wk.has(istDayKey(c.startTime)));

  // Deliberately not excluding existing friends: this section ranks by activity compatibility,
  // not relationship status — a friend can still be the best match for a specific plan.
  const peoplePool = Object.values(db.users).filter(u =>
    u.id !== viewer.id && u.discoverable !== false && u.username !== 'demo' &&
    !safety.isBlocked(db, viewer.id, u.id) && u.city === viewer.city);
  const people = matching.rankCandidates(db, viewer, peoplePool, {}, 20).map(r => ({ ...r, user: auth.publicUser(db.users[r.user_id]) }));

  const communityCards = Object.values(db.communities)
    .filter(c => c.visibility === 'public' || c.members.some(m => m.userId === viewer.id))
    .map(c => communityCard(viewer, c)).sort((a, b) => b.recommendation_score - a.recommendation_score);

  return {
    forYou: { plans: planCards.slice(0, 6), people: people.slice(0, 3), communities: communityCards.slice(0, 3) },
    tonight: { plans: tonight.slice(0, 10) },
    weekend: { plans: weekend.slice(0, 10) },
    people: { items: people },
  };
}

// ---------------------------------------------------------------- POST /discover/im-free

function windowFor(when, body) {
  const today = istDayKey(new Date());
  const nowH = istHour(new Date());
  if (when === 'now') return { date: today, from: Math.max(0, nowH - 0.25), to: Math.min(30, nowH + 3) };
  if (when === 'tonight') return { date: today, from: Math.max(17, Math.min(nowH, 22)), to: 23 };
  if (when === 'tomorrow') return { date: addDaysKey(today, 1), from: 9, to: 23 };
  const date = /^\d{4}-\d\d-\d\d$/.test(body.customDate) ? body.customDate : today;
  const from = Number.isFinite(+body.customFrom) ? Math.max(0, +body.customFrom) : 18;
  const to = Number.isFinite(+body.customTo) ? Math.max(from + 1, +body.customTo) : from + 3;
  return { date, from, to };
}

function isoFor(dateKey, hour) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return istISO(y, m, d + Math.floor(hour / 24), Math.floor(hour % 24), Math.round((hour % 1) * 60));
}

async function imFree(db, user, body) {
  const win = windowFor(body.when, body);
  const activities = Array.isArray(body.activities) && body.activities.length ? body.activities.slice(0, 5) : (user.interests?.length ? user.interests.slice(0, 3) : ['meetups']);
  const radiusKm = Math.max(0.5, Math.min(50, +body.radiusKm || 5));
  const budget = nlp.cleanBudget(body.budget);
  const groupSize = Math.max(2, Math.min(30, +body.groupSize || 4));
  const viewerPt = geo.userPoint(user);

  // Remember this as a short-lived availability window so matching (and the next feed load) sees it.
  try { availability.add(db, user.id, { type: 'once', date: win.date, startHour: win.from, endHour: win.to, source: 'im_free', ttlHours: 14, label: body.when }); } catch {}

  const cards = activities.map(activityId => {
    const existing = openPlansFor(db, user).find(p => {
      if (p.activityType !== activityId) return false;
      const ctx = plansService.matchContext(p);
      if (ctx.dateKey !== win.date || !(ctx.fromHour < win.to && ctx.toHour > win.from)) return false;
      if (!viewerPt || p.areaLat == null) return true;
      return geo.approxDistanceKm(viewerPt, { lat: p.areaLat, lng: p.areaLng }) <= radiusKm * 1.4;
    });
    if (existing) {
      const km = viewerPt && existing.areaLat != null ? geo.approxDistanceKm(viewerPt, { lat: existing.areaLat, lng: existing.areaLng }) : null;
      return {
        kind: 'existing', planId: existing.id, activity: activityId, activityLabel: INTEREST_LABEL[activityId] || activityId,
        title: existing.title, startTime: existing.startTime, endTime: existing.endTime, budgetPerPerson: existing.budgetPerPerson,
        distanceLabel: geo.distanceLabel(km), interestedCount: plansService.acceptedCount(existing),
        sampleParticipants: existing.participants.filter(p => p.status === 'accepted').slice(0, 4).map(p => auth.publicUser(db.users[p.userId])),
      };
    }
    const virtualPlan = { creatorId: user.id, city: user.city, areaLat: viewerPt?.lat ?? null, areaLng: viewerPt?.lng ?? null, radiusKm, visibility: 'public' };
    const pool = plansService.candidatePool(db, virtualPlan, new Set([user.id]));
    const ranked = matching.rankCandidates(db, user, pool, { activityId, dateKey: win.date, fromHour: win.from, toHour: win.to, radiusKm }, 8);
    return {
      kind: 'suggested', planId: null, activity: activityId, activityLabel: INTEREST_LABEL[activityId] || activityId,
      title: `${INTEREST_LABEL[activityId] || activityId} plan`, startTime: isoFor(win.date, win.from), endTime: isoFor(win.date, win.to),
      budgetPerPerson: budget, distanceLabel: null, interestedCount: ranked.length,
      sampleParticipants: ranked.slice(0, 4).map(r => auth.publicUser(db.users[r.user_id])),
      suggestedIntent: { activity: activityId, interests: [activityId], date: win.date, time_range: [nlp.hourToHHMM(win.from), nlp.hourToHHMM(win.to)], budget, participants_needed: groupSize, radius_km: radiusKm },
    };
  }).sort((a, b) => b.interestedCount - a.interestedCount);

  return { window: win, cards };
}

module.exports = { feedFor, imFree, planCard, communityCard };
