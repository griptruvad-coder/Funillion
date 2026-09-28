// Plan business logic: status machine, matching/invitations, chat, timing votes.
// This is the only place that writes to db.plans — nothing upstream (routes, the LLM intent
// parser) touches plan data directly, so "the LLM never makes database decisions" holds by
// construction: intent.js hands back plain JSON, and only functions here turn it into a plan.
const crypto = require('crypto');
const geo = require('../geo');
const safety = require('../safety');
const matching = require('../matching/compatibility');
const chat = require('../chat');
const auth = require('../auth');
const { istISO, istDayKey, istHour } = require('../util');
const { INTEREST_LABEL } = require('../interests');
const { fmtDay } = require('../planner');
const { HttpError } = require('../errors');

const STATUSES = ['DRAFT', 'MATCHING', 'INVITING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];
const OPEN_STATUSES = new Set(['DRAFT', 'MATCHING', 'INVITING']);
const INVITE_MULTIPLIER = 2.5; // invite more people than needed since not everyone accepts
const GRACE_MS = 90 * 60000; // how long an unfinalized plan waits past its start time before auto-cancelling

function badRequest(msg, status = 400) { return new HttpError(status, msg); }

function titleFor(intent) {
  const label = INTEREST_LABEL[intent.activity] || (intent.activity ? intent.activity : 'Meetup');
  let when = '';
  try { when = ' · ' + fmtDay(intent.date).replace(/^\w+, /, ''); } catch {}
  return `${label}${when}`;
}

// "HH:MM" strings are wall-clock IST with no day info, so an end time earlier than the start
// (e.g. 19:00 -> 02:00) means it rolls into the next day.
function timeRangeToIso(dateKey, timeRange) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [sh, sm] = (timeRange?.[0] || '18:00').split(':').map(Number);
  const [eh, em] = (timeRange?.[1] || '21:00').split(':').map(Number);
  const startTime = istISO(y, m, d, sh, sm);
  const rollsOver = eh < sh || (eh === sh && em <= sm);
  const endTime = istISO(y, m, d + (rollsOver ? 1 : 0), eh, em);
  return { startTime, endTime };
}

// Builds a DRAFT plan from a validated intent (see server/plans/intent.js). The creator is
// immediately an accepted participant.
function createPlan(db, creator, intent, { communityId = null, visibility = 'public' } = {}) {
  if (!intent.activity && !intent.interests?.length) throw badRequest("Couldn't tell what you want to do — try naming an activity");
  const point = geo.userPoint(creator);
  const { startTime, endTime } = timeRangeToIso(intent.date, intent.time_range);
  const id = 'pl_' + crypto.randomBytes(6).toString('hex');
  const plan = {
    id, creatorId: creator.id, title: titleFor(intent), description: intent.raw ? String(intent.raw).slice(0, 300) : '',
    activityType: intent.activity, interests: intent.interests?.length ? intent.interests : [intent.activity].filter(Boolean),
    startTime, endTime, timeFlexible: false, timeOptions: [],
    budgetPerPerson: Number.isFinite(intent.budget) ? intent.budget : null,
    maxParticipants: Math.max(2, Math.min(30, intent.participants_needed || 3)),
    minParticipants: Math.max(2, Math.min(30, intent.participants_needed || 3)),
    city: intent.city, areaLat: point?.lat ?? null, areaLng: point?.lng ?? null, radiusKm: intent.radius_km || 5,
    venueHint: null, visibility, communityId,
    status: 'DRAFT',
    participants: [{ userId: creator.id, role: 'creator', status: 'accepted', compatibilityScore: 1, reasons: [], invitedAt: new Date().toISOString(), respondedAt: new Date().toISOString() }],
    conversationId: null, parser: intent.parser || 'funillion-nlp', rawQuery: intent.raw || '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  db.plans[id] = plan;
  return plan;
}

function inCommunity(db, communityId, userId) {
  const c = communityId && db.communities[communityId];
  return !!c && c.members.some(m => m.userId === userId);
}

// Same pool builder used by both plan matching and the compatibility-only /matching/users endpoint.
function candidatePool(db, plan, excludeIds) {
  const planPoint = plan.areaLat != null ? { lat: plan.areaLat, lng: plan.areaLng } : null;
  return Object.values(db.users).filter(u => {
    if (excludeIds.has(u.id) || u.discoverable === false || u.username === 'demo') return false;
    if (safety.isBlocked(db, plan.creatorId, u.id)) return false;
    if (plan.visibility === 'verified_only' && !u.verified) return false;
    if (plan.visibility === 'community_only' && !inCommunity(db, plan.communityId, u.id)) return false;
    if (!planPoint) return u.city === plan.city;
    const pt = geo.userPoint(u);
    if (!pt) return u.city === plan.city;
    return geo.approxDistanceKm(planPoint, pt) <= (plan.radiusKm || 5) * 1.4; // areas are coarse polygons, not points — small grace
  });
}

function matchContext(plan) {
  const fromHour = istHour(plan.startTime);
  let toHour = istHour(plan.endTime);
  if (toHour <= fromHour) toHour += 24; // end time rolled past midnight relative to the start
  return { activityId: plan.activityType, dateKey: istDayKey(plan.startTime), fromHour, toHour, radiusKm: plan.radiusKm };
}

// DRAFT -> MATCHING: score every eligible candidate. Returns the ranked list (spec shape:
// {user_id, compatibility_score, reasons}) without inviting anyone yet.
function findMatchingUsers(db, plan, limit = 20) {
  if (plan.status === 'DRAFT') { plan.status = 'MATCHING'; plan.updatedAt = new Date().toISOString(); }
  const excludeIds = new Set(plan.participants.map(p => p.userId));
  const creator = db.users[plan.creatorId];
  const pool = candidatePool(db, plan, excludeIds);
  return matching.rankCandidates(db, creator, pool, matchContext(plan), limit);
}

// MATCHING -> INVITING: invite the top-ranked candidates (more than needed, since not everyone
// accepts) and open the plan's group chat.
function inviteTopCandidates(db, plan) {
  const need = plan.maxParticipants - plan.participants.length;
  if (need <= 0) return plan;
  const ranked = findMatchingUsers(db, plan, Math.ceil(need * INVITE_MULTIPLIER));
  const now = new Date().toISOString();
  for (const r of ranked) {
    if (plan.participants.some(p => p.userId === r.user_id)) continue;
    plan.participants.push({ userId: r.user_id, role: 'member', status: 'invited', compatibilityScore: r.compatibility_score, reasons: r.reasons, invitedAt: now, respondedAt: null });
  }
  plan.status = 'INVITING';
  if (!plan.conversationId) plan.conversationId = chat.createConversation(db, 'plan', plan.id);
  plan.updatedAt = now;
  return plan;
}

function acceptedCount(plan) { return plan.participants.filter(p => p.status === 'accepted').length; }

function maybeConfirm(db, plan) {
  if (OPEN_STATUSES.has(plan.status) && acceptedCount(plan) >= plan.minParticipants) confirmPlan(db, plan, null);
}

function confirmPlan(db, plan, byUserId) {
  plan.status = 'CONFIRMED'; plan.updatedAt = new Date().toISOString();
  if (!plan.conversationId) plan.conversationId = chat.createConversation(db, 'plan', plan.id);
  chat.postMessage(db, plan.conversationId, byUserId || plan.creatorId, `🎉 Plan confirmed — ${acceptedCount(plan)} people in. See you at ${plan.title}!`, { system: true });
}

// A user responds to an invitation (or, for an open public plan they weren't invited to, joins directly).
function respond(db, plan, userId, accept) {
  if (plan.status === 'CANCELLED' || plan.status === 'COMPLETED') throw badRequest('This plan is no longer open');
  let p = plan.participants.find(x => x.userId === userId);
  if (!p) throw badRequest('You were not invited to this plan', 404);
  if (p.status === 'left') throw badRequest('You already left this plan');
  p.status = accept ? 'accepted' : 'declined';
  p.respondedAt = new Date().toISOString();
  plan.updatedAt = p.respondedAt;
  if (!plan.conversationId) plan.conversationId = chat.createConversation(db, 'plan', plan.id);
  if (accept) chat.postMessage(db, plan.conversationId, userId, `${db.users[userId]?.name?.split(' ')[0] || 'Someone'} joined the plan 👋`, { system: true });
  maybeConfirm(db, plan);
  return p;
}

// Direct join for a public/open plan (no formal invitation needed) — used by "I'm Free" convergence
// and the discovery feed's Join button.
function join(db, plan, user) {
  if (!OPEN_STATUSES.has(plan.status) && plan.status !== 'CONFIRMED') throw badRequest('This plan is no longer open');
  if (plan.visibility === 'private') throw badRequest('This plan is invite-only');
  if (plan.visibility === 'verified_only' && !user.verified) throw badRequest('This plan is for verified users only');
  if (plan.visibility === 'community_only' && !inCommunity(db, plan.communityId, user.id)) throw badRequest('This plan is for community members only');
  if (safety.isBlocked(db, plan.creatorId, user.id)) throw badRequest('You cannot join this plan', 403);
  if (acceptedCount(plan) >= plan.maxParticipants) throw badRequest('This plan is already full');
  let p = plan.participants.find(x => x.userId === user.id);
  if (p && p.status === 'accepted') return p;
  const ctx = matchContext(plan);
  const creator = db.users[plan.creatorId];
  const scored = matching.scoreCandidate(db, creator, user, ctx);
  const now = new Date().toISOString();
  if (p) { p.status = 'accepted'; p.respondedAt = now; }
  else { p = { userId: user.id, role: 'member', status: 'accepted', compatibilityScore: scored.compatibility_score, reasons: scored.reasons, invitedAt: now, respondedAt: now }; plan.participants.push(p); }
  if (plan.status === 'DRAFT') plan.status = 'MATCHING';
  if (!plan.conversationId) plan.conversationId = chat.createConversation(db, 'plan', plan.id);
  chat.postMessage(db, plan.conversationId, user.id, `${user.name.split(' ')[0]} joined the plan 👋`, { system: true });
  plan.updatedAt = now;
  maybeConfirm(db, plan);
  return p;
}

function leave(db, plan, userId) {
  const p = plan.participants.find(x => x.userId === userId);
  if (!p) return;
  p.status = 'left'; plan.updatedAt = new Date().toISOString();
  if (userId === plan.creatorId) {
    const next = plan.participants.find(x => x.status === 'accepted' && x.userId !== userId);
    if (next) { plan.creatorId = next.userId; next.role = 'creator'; }
    else { plan.status = 'CANCELLED'; }
  }
}

function finalize(db, plan, byUserId) {
  if (byUserId !== plan.creatorId) throw badRequest('Only the plan creator can finalize it', 403);
  if (!OPEN_STATUSES.has(plan.status)) throw badRequest('This plan is already ' + plan.status.toLowerCase());
  if (acceptedCount(plan) < 2) throw badRequest('Need at least one other person to accept first');
  confirmPlan(db, plan, byUserId);
}

function cancel(db, plan, byUserId) {
  if (byUserId !== plan.creatorId) throw badRequest('Only the plan creator can cancel it', 403);
  if (plan.status === 'COMPLETED' || plan.status === 'CANCELLED') throw badRequest('This plan is already ' + plan.status.toLowerCase());
  plan.status = 'CANCELLED'; plan.updatedAt = new Date().toISOString();
  if (plan.conversationId) chat.postMessage(db, plan.conversationId, byUserId, 'This plan was cancelled by the organiser.', { system: true });
}

// Lets the creator flag a no-show after the fact — a real, explicit signal (never inferred) that
// feeds the reliability_score of the compatibility engine.
function markNoShow(db, plan, byUserId, targetUserId) {
  if (byUserId !== plan.creatorId) throw badRequest('Only the plan creator can do this', 403);
  if (plan.status !== 'COMPLETED') throw badRequest('Can only mark no-shows after the plan has happened');
  db.interactions.push({ userId: targetUserId, planId: plan.id, type: 'plan_no_show', at: new Date().toISOString() });
}

function addTimeOption(db, plan, userId, start, end) {
  const opt = { id: 'to_' + crypto.randomBytes(4).toString('hex'), start, end, votes: [userId] };
  plan.timeOptions.push(opt); plan.timeFlexible = true; plan.updatedAt = new Date().toISOString();
  return opt;
}
function voteTimeOption(db, plan, userId, optionId) {
  const opt = plan.timeOptions.find(o => o.id === optionId);
  if (!opt) throw badRequest('Time option not found', 404);
  opt.votes = opt.votes.includes(userId) ? opt.votes.filter(v => v !== userId) : [...opt.votes, userId];
  plan.updatedAt = new Date().toISOString();
  return opt;
}

// Lazy status maintenance, called at the top of any plan read (same idiom as sweepHolds() in
// server.js for booking holds) — no background cron needed.
function sweep(db) {
  const now = Date.now();
  for (const plan of Object.values(db.plans)) {
    if (plan.status === 'CONFIRMED' && new Date(plan.endTime).getTime() < now) {
      plan.status = 'COMPLETED'; plan.updatedAt = new Date().toISOString();
      for (const p of plan.participants) if (p.status === 'accepted') db.interactions.push({ userId: p.userId, planId: plan.id, type: 'plan_completed', at: plan.updatedAt });
    } else if (OPEN_STATUSES.has(plan.status) && new Date(plan.startTime).getTime() + GRACE_MS < now) {
      plan.status = 'CANCELLED'; plan.updatedAt = new Date().toISOString();
    }
  }
}

function publicParticipant(db, p) { return { ...auth.publicUser(db.users[p.userId]), role: p.role, status: p.status, compatibilityScore: p.compatibilityScore, reasons: p.reasons }; }

function view(db, plan, viewerId) {
  const me = plan.participants.find(p => p.userId === viewerId);
  return {
    id: plan.id, title: plan.title, description: plan.description, activityType: plan.activityType, interests: plan.interests,
    startTime: plan.startTime, endTime: plan.endTime, timeFlexible: plan.timeFlexible,
    timeOptions: plan.timeOptions.map(o => ({ ...o, myVote: o.votes.includes(viewerId), votes: o.votes.length })),
    budgetPerPerson: plan.budgetPerPerson, maxParticipants: plan.maxParticipants, minParticipants: plan.minParticipants,
    city: plan.city, radiusKm: plan.radiusKm, venueHint: plan.venueHint, visibility: plan.visibility, communityId: plan.communityId,
    status: plan.status, creatorId: plan.creatorId, isCreator: plan.creatorId === viewerId,
    myStatus: me ? me.status : null,
    participants: plan.participants.filter(p => p.status === 'accepted' || p.userId === viewerId || plan.creatorId === viewerId).map(p => publicParticipant(db, p)),
    acceptedCount: acceptedCount(plan), createdAt: plan.createdAt,
  };
}

module.exports = { STATUSES, OPEN_STATUSES, createPlan, candidatePool, matchContext, timeRangeToIso, inCommunity, findMatchingUsers, inviteTopCandidates, respond, join, leave, finalize, cancel, markNoShow, confirmPlan, addTimeOption, voteTimeOption, sweep, view, acceptedCount };
