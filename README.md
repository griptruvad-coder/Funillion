# Funillion ✳ — A million ways to have fun

India's everything-events app. Concerts, comedy, hackathons, bhajan clubbing, parties, meetups, open mics, workshops, fests, sports — across 14 cities. Discover, plan your day with AI, plan with friends and book tickets.

## Run it (2 minutes)

You need **Node.js 18 or newer** (check with `node -v`). There's nothing to `npm install`.

```bash
cd Funillion
node server.js
```

Open **http://localhost:3000**

- **Demo account:** `demo` / `funillion` (Delhi, already has friends and a group plan)
- Or sign up → pick your city → pick interests → your feed is personalised
- Fresh data: `node server.js --reseed` (wipes users/bookings and rebuilds events for the next 3 weeks)
- Different port: `set PORT=4000 && node server.js` (Windows) · `PORT=4000 node server.js` (Mac/Linux)

The first run builds `data/db.json` and the source feeds in `data/sources/`. When events start getting old, the server pulls fresh feeds on its own at startup.

## What's inside

| Feature | Where to see it | Code |
|---|---|---|
| **Login + city** — signup asks your city and interests; feed, map and planner follow that city; switch any time | Header → city button | `server/auth.js`, `public/js/core.js` |
| **Pan-India catalogue** — 14 cities, 17 categories, ~1,900 events | Landing, Discover | `server/catalog.js`, `server/seed.js` |
| **Smart Event Aggregation** — 3 sources with different schemas → normalise → dedupe → one listing per event (2,700 raw → 1,920 unique; 0 false merges in testing) | Avatar menu → Organizer → Smart aggregation; "Where this listing comes from" on event pages | `server/aggregator.js` |
| **Event Submission Engine** — paste an event URL, it reads schema.org/Open Graph data and fills the form; duplicates are merged | Organizer → Add an event | `server/importer.js` |
| **Personalised "For You"** — interests + your activity (views, saves, bookings, decaying over time) + friends + popularity + urgency, with diversity re-ranking and "why" labels | Discover (logged in) | `server/feed.js` |
| **Trending near you** — Hot tonight, This weekend, Almost sold out, Free | Discover | `server/feed.js` |
| **Map View** — every event on a map, filters, "sort by distance from me" | Map tab | `public/js/pages/map.js` |
| **AI Plan My Day** — English + Hinglish ("couple ke liye ₹1500 me plan, kal shaam, Bandra") → budget, date, time, area, group size, vibe → optimised itinerary with travel times, breaks, cost, map route | Plan my day tab | `server/planner.js` |
| **Friends & Group Planning** — add friends, see what they're interested in, group plans with voting, chat, invite links, lock the final pick | Friends tab | `server.js` (groups), `public/js/pages/social.js` |
| **Ticket booking** — ticket types, 10-minute seat hold, attendee details, UPI/card/netbanking (demo gateway), QR e-ticket, .ics + Google Calendar, cancellation with refund rules | Any event → Get tickets | `server.js` (bookings), `public/js/pages/booking.js` |
| **Organizer analytics** — views, clicks, saves, tickets, revenue | Organizer → My events | `server.js` |

## Architecture

```
server.js              HTTP server + REST API (no framework, no dependencies)
server/
  catalog.js           cities, areas (with lat/lng + zones), categories, event templates
  interests.js          interest taxonomy (event categories + finer social tags) shared by profiles/plans/communities
  geo.js                privacy-preserving location: area centroid + per-user jitter, distance labels only
  safety.js             block / report
  nlp.js                shared date · time · budget · headcount parsing (used by planner.js AND plans/intent.js)
  seed.js              generates the 3 demo source feeds + demo people
  aggregator.js        adapters → normalise → dedupe (blocking + fuzzy scoring) → merge
  feed.js              For You ranking, trending shelves, Fun Score (events)
  planner.js           Hinglish parser + itinerary optimiser — "AI Plan My Day" (events)
  importer.js          URL → event draft (JSON-LD / Open Graph), with private-network protection
  auth.js              scrypt password hashing, HttpOnly session cookies
  db.js                JSON file store (atomic writes) + versioned schema migration
  availability/         recurring + one-off free-time windows, overlap checks
  matching/compatibility.js   deterministic social compatibility scoring (see below)
  plans/                intent.js (AI Create-a-Plan text → JSON) + service.js (status machine, matching/invites, chat)
  discovery/            Smart Discovery Feed + "I'm Free"
  communities/          interest communities: members, posts, plans, chat
  chat.js                conversation/message log shared by plan chat + community chat
public/                single-page app (vanilla JS modules), Leaflet map, QR codes
  js/pages/create.js    AI Create-a-Plan composer + "I'm Free" flow
  js/pages/plans.js     plan list + detail (participants, compatibility, chat, finalize)
  js/pages/communities.js  community list + detail
data/                  created on first run (db.json + sources/*.json)
```

## Social matching & real-world plans

*"Tell us what you want to do. Funillion finds the right people and turns it into a real-world plan."*

Five features on top of the events app above, reusing the same auth, JSON store, router and vanilla-JS frontend — **nothing about the events/ticketing side changed.**

### 1. AI "Create a Plan" — the flagship feature

Typing "Need 3 people for a café meetup under ₹500" runs a 3-layer pipeline, same shape as the existing "AI Plan My Day":

1. **Deterministic parse** (`server/plans/intent.js`) — regex/keyword extraction (English + Hinglish) into `{activity, date, time_range, budget, participants_needed, radius_km, interests}`.
2. **Optional Claude refinement** (only with `ANTHROPIC_API_KEY`) — Claude receives *only the free text* and returns the same plain JSON shape; every field is type-checked, range-clamped and whitelisted against the interest taxonomy before use. **The model never sees the database and never decides who gets invited** — it only ever hands back JSON that the code below validates.
3. **Deterministic business logic** (`server/plans/service.js`) — `createPlan` → `findMatchingUsers` (ranks candidates with the compatibility engine) → `inviteTopCandidates` (invites ~2.5× the target headcount, since not everyone accepts) → creates the plan's group chat. Accept/decline is tracked per participant; the plan auto-confirms once enough people accept, or the creator can finalize early.

**Status machine:** `DRAFT → MATCHING → INVITING → CONFIRMED → COMPLETED | CANCELLED`, enforced in `server/plans/service.js` (every mutating function checks the current status before acting) and swept lazily on read (`sweep()` — same idiom as the existing booking-hold sweep in `server.js`): a `CONFIRMED` plan past its end time becomes `COMPLETED` (and logs a `plan_completed` interaction per accepted participant, feeding reliability_score); an unfinalized plan left open past its start time auto-cancels.

### 2. Social Compatibility Engine (`server/matching/compatibility.js`)

```
compatibility_score = 0.30·interest_similarity + 0.20·availability_overlap + 0.20·distance_score
                     + 0.15·activity_preference + 0.10·community_overlap  + 0.05·reliability_score
```

- **interest_similarity** — Jaccard overlap of the two users' interest tags.
- **availability_overlap** — checks the candidate's stated `availability` windows against the requested time; no stated availability at all scores neutral (0.5), not zero — silence isn't "unavailable."
- **distance_score** — `1 − distance/radius_km` between two *approximate* points (see privacy below).
- **activity_preference** — 1 if the candidate lists the activity (or a related broader interest — e.g. "networking" counts for "startups") as an interest, else a recency-weighted score from their past event interactions in that category.
- **community_overlap** — Jaccard of the two users' community memberships.
- **reliability_score** — completed vs. no-show/late-cancelled plans, Laplace-smoothed so a new user starts at a fair 0.75, not 0.
- Returns `{ user_id, compatibility_score, reasons: [...] }` — never raw sub-scores or interaction history, only the rounded headline number and a couple of plain-English reasons.
- **Weights are configurable** via env vars (`MATCH_WEIGHT_INTEREST`, `_AVAILABILITY`, `_DISTANCE`, `_ACTIVITY`, `_COMMUNITY`, `_RELIABILITY`) without a code change; defaults are the numbers above.

### 3. "I'm Free" mode (`server/discovery/index.js` `imFree()`, `public/js/pages/create.js`)

One-tap CTA on Discover/Create: **Now / Tonight / Tomorrow / Custom**, plus optional budget, radius, activities and group size. For each selected activity, it either surfaces a genuinely **open, joinable plan** already at that time/place (real accepted-participant count) or a **suggested** plan backed by a real count of ranked compatible people nearby — tapping Join on a suggestion creates the plan through the same pipeline as Create-a-Plan. Cards never show a fabricated "N interested"; it's always a real query result.

### 4. Smart Discovery Feed (`GET /discover/feed`)

Sections **For You** (plans + people + communities), **Happening Tonight**, **This Weekend**, **People You May Want to Meet** (only `discoverable` users, only same-city, never already-blocked). Each item carries `reasons` built from whichever factors actually contributed (shared interests, "fits your free time", distance, freshness) — the same pattern as the existing event feed's "why" labels. A section with nothing genuinely matching returns empty, not filler.

### 5. Communities (`server/communities/index.js`)

Persistent interest groups (members/moderators/posts/announcements/a group chat, all backed by the same `chat.js` conversation log a Plan uses) whose purpose is turning the group into a real-world plan via **"Create Plan for Community"** — a normal Create-a-Plan call with `communityId` set, scoped so only members are matched/invited when the plan's visibility is `community_only`. Members can vote on a proposed time (`timeOptions` on the plan, same voting pattern as the existing event-group feature).

### Privacy & safety

- **Never exact location.** Users pick a coarse *area* (a city neighbourhood, not a pin); the server adds a small per-user, deterministic jitter and only ever returns **rounded distance labels** ("~3 km away") to the client — raw coordinates never leave `server/geo.js`.
- **Block / report** (`server/safety.js`, `POST /users/:id/block`, `POST /reports`) — blocked users are filtered out of matching, invites, discovery and joins everywhere (`candidatePool`, `rankCandidates`, the discovery feed).
- **Discoverability toggle** (`PATCH /me {discoverable}`) — off hides a user from matching/discovery/"I'm Free" entirely; their existing plans are unaffected.
- **Plan visibility tiers** — `public`, `community_only` (members of the linked community only, enforced in matching, joining and viewing), `private` (invited participants only), `verified_only`.

### Known limitation: the database

The spec asked for "proper foreign keys, indexes and migrations." This app is deliberately zero-dependency with a single JSON-file store (see below) — adding a real RDBMS now would be a bigger change than this phase called for, and the README already earmarked `db.js` as the one place to swap later. Instead: **application-level FK validation** (every reference is checked in code, e.g. a plan's `communityId` must resolve to a real community), **in-memory indexing** (`Object.values(db.x).filter(...)`, fast enough at this scale), and **real versioned migrations** (`server/db.js` `migrate()`, bumps `meta.version`, moves data rather than dropping it — e.g. v1→v2 relocated the old `plans` collection to `itineraryQueries` when `plans` was repurposed for the new feature). All access goes through the module functions in `server/plans/`, `server/communities/`, etc., not raw `db.x` reads scattered around — so swapping in Postgres later stays a localized change, as the existing README already promised.

### Data model

New `data/db.json` collections (schema v2 — see the migration note above). Requested models map onto these as noted:

| Collection | Shape | Notes |
|---|---|---|
| `users[id]` | *(existing, extended)* `+ homeArea, discoverable, verified` | `interests` (existing field) doubles as **UserInterest**; `Interest`/`Availability` catalog is `server/interests.js` (static, not per-user rows) |
| `availability[id]` | `{id, userId, type:'recurring'\|'once', dayOfWeek, date, startHour, endHour, label, source, createdAt, expiresAt}` | |
| `plans[id]` | `{id, creatorId, title, description, activityType, interests[], startTime, endTime, timeOptions[], budgetPerPerson, maxParticipants, minParticipants, city, areaLat, areaLng, radiusKm, visibility, communityId, status, participants[], conversationId, createdAt, updatedAt}` | `participants[]` = `{userId, role, status, compatibilityScore, reasons, invitedAt, respondedAt}` — this one array *is* **PlanParticipant** and **PlanInvitation** (an invitation is a participant row with `status:'invited'`) |
| `communities[id]` | `{id, slug, name, description, icon, interestTags[], visibility, creatorId, members[], posts[], conversationId, createdAt}` | `members[]` = `{userId, role, joinedAt}` is **CommunityMember** |
| `conversations[id]` / `messages[convId]` | `{id, kind:'plan'\|'community', refId}` / `[{id, userId, text, system, at}]` | shared by plan chat + community chat |
| `blocks[]` / `reports[]` | `{blockerId, blockedId, at}` / `{id, reporterId, targetType, targetId, reason, note, at, status}` | **Interaction** (reliability signal) reuses the existing `interactions[]` log with new `type`s: `plan_completed`, `plan_no_show` |

The originally-requested flat `Plan` fields (`id, creator_id, title, description, activity_type, start_time, end_time, budget, max_participants, latitude, longitude, radius_km, status, created_at`) are all present, just camelCase and with `budget`→`budgetPerPerson`, `latitude/longitude`→`areaLat/areaLng` (approximate, see Privacy above) to make the semantics explicit.

### API reference

All under `/api`, all requiring a logged-in session except the `GET`s noted. Mirrors the existing router (`server.js` `route(method, pattern, handler)` — `need(user)` guards auth, `fail(status, msg)` throws a clean JSON error).

| Method & path | What it does |
|---|---|
| `POST /plans/parse-intent` | Text → structured intent JSON (step 1–2 of Create-a-Plan) |
| `POST /plans` | Create a plan (from `text`, or fields directly) → auto-matches & invites |
| `GET /plans` | My plans (any status) |
| `GET /plans/:id` | Plan detail + messages *(public plans viewable logged out is N/A — auth required)* |
| `POST /plans/:id/join` / `/leave` | Join an open plan directly / leave |
| `POST /plans/:id/respond` | Accept/decline an invitation |
| `POST /plans/:id/finalize` / `/cancel` | Creator locks it in early / cancels |
| `POST /plans/:id/messages` | Plan group chat |
| `POST /plans/:id/time-options` / `/time-options/:id/vote` | Propose/vote on a time (community "vote on timing") |
| `POST /plans/:id/no-show` | Creator flags a no-show → feeds reliability_score |
| `GET /matching/users` | Ranked compatible people (same city + radius), `?activity=&radiusKm=&limit=` |
| `POST /availability` · `GET /availability/me` · `DELETE /availability/:id` | Manage availability windows |
| `POST /discover/im-free` | Now/Tonight/Tomorrow/Custom → actionable cards |
| `GET /discover/feed` | For You / Tonight / Weekend / People sections |
| `GET /communities` · `POST /communities` | List (public + mine) / create |
| `GET /communities/:id` · `POST /communities/:id/join` · `/leave` | Detail / join / leave |
| `GET /communities/:id/plans` · `POST /communities/:id/posts` · `/messages` | Plans-for-community, posts, chat |
| `GET /blocked` · `POST /users/:id/block` · `/unblock` · `POST /reports` | Safety |

### Try it

```bash
node server.js   # demo login: demo / funillion
```
Discover → hero "What do you want to do today?" → type e.g. *"Anyone up for badminton tomorrow evening?"* → Create tab shows the parsed intent, editable → **Create plan & find people** → lands on the plan's page with real ranked/invited demo people, a compatibility badge + reasons on each, and a live chat. Try **I'm Free** on the same page for the quick-tap flow, **Plans** in the main nav for the list, and **Communities** → open one → **Create plan for community**. Accept/decline, finalize and chat all work with a second real account (sign up a second user in another browser/incognito window — demo bots can't log in, but they *do* get invited/ranked as real candidates).

**What was actually tested:** the full flow above was driven headlessly end-to-end (Playwright) against a fresh demo boot — signup, intent parsing on all 4 example prompts from the spec, plan creation with real matched/invited/ranked bots, chat, finalize/cancel status transitions, I'm Free (existing-vs-suggested cards), community join + create-plan-for-community, block/report, the discoverability toggle, and a full regression pass over the untouched events/booking/friends features. No console errors or broken interactions turned up in the final pass; several real bugs found along the way (error messages being swallowed into a generic 500, a `null` budget silently becoming "Free", `/matching/users` not filtering by city/radius, `community_only` plans not actually being community-only) were fixed and re-verified.


## Production setup (Railway)

Set these in **Railway → service → Variables** (full list with comments in `.env.example`). Never put keys in the code — the repo is on GitHub.

| Variable | What it does |
|---|---|
| `SERPAPI_KEY` | Turns on **real events** for all cities from Google Events (BookMyShow, District, AllEvents, Insider…). First pull runs ~3 s after deploy, then every 7 days. |
| `ADMIN_EMAILS` | Your Funillion login email → you get the **"Pull real events now"** button (Organizer → Smart aggregation). |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Real checkout. Use **test keys** (`rzp_test_…`) until real organisers list real events. Without keys the demo gateway is used. |
| `RAZORPAY_WEBHOOK_SECRET` | Confirms bookings even if the buyer closes the tab after paying; tracks refunds. |
| `ALLOWED_ORIGINS` | Your Netlify/custom domains (login breaks with 403 without it). |
| `SESSION_DAYS` | How long users stay logged in (default 90; renewed on every visit after a week). |
| `ANTHROPIC_API_KEY` | Better English/Hinglish understanding for **both** "AI Plan My Day" and the new "Create a Plan" intent parser (`FUNILLION_MODEL` picks the model). Optional — the built-in NLP parser is the fallback either way; the model only ever returns JSON, never touches the database. |
| `MATCH_WEIGHT_INTEREST` / `_AVAILABILITY` / `_DISTANCE` / `_ACTIVITY` / `_COMMUNITY` / `_RELIABILITY` | Tune the compatibility engine's weights (default 0.30/0.20/0.20/0.15/0.10/0.05) without a code change. |

On Railway, demo data is **off by default**: the first deploy removes all fake events and demo people (Meera & co.) and keeps real accounts.

**Razorpay webhook:** Dashboard → Settings → Webhooks → Add: URL `https://<railway-domain>/api/razorpay/webhook`, events `payment.captured`, `order.paid`, `refund.processed`, `refund.failed`, secret = `RAZORPAY_WEBHOOK_SECRET`.

### Funillion crawler (free real events, all cities)
`server/crawler/` reads public event pages on AllEvents, District, Eventbrite, Townscript and Luma (list in `server/crawler/sites.js`), plus hackathons from **Devpost, Unstop, Devfolio, HackerEarth and Hack2Skill** (`server/crawler/hackathons.js`), every 12 h:
1. checks each site's **robots.txt** (skips anything disallowed, honours Crawl-delay) and identifies itself as `FunillionBot`
2. opens the city listing pages + event sitemaps, then the event pages (one request at a time per site, ≥1.5 s apart; a site that keeps refusing is left alone)
3. reads the **schema.org Event** data sites publish for search engines — title, date/time, venue, geo, price — and keeps only upcoming, in-person events in our 14 cities
4. hands them to the aggregator, which merges the same event from different sites into one listing with every booking link
5. remembers pages it has read, so later runs only fetch new/stale pages

**Hackathons:** these platforms are read through the public JSON their own listing pages use (a few paged requests per run, still robots.txt-checked). Offline hackathons land in their city; **online hackathons** get the virtual city `online` — they show in every city's Discover (filter "🌐 Online", shelf "Online hackathons"), on `/in/online/hackathons`, never on the map or in the day planner. Prizes, themes and registration deadlines are shown on cards and event pages. The same hackathon on two platforms is merged.

Only facts + a link back are stored (no images or copied descriptions). BookMyShow is off by default because its terms restrict automated access. Admins see per-site stats and a **Run crawler now** button in Organizer → Smart aggregation.

### SEO pages (Google traffic)
The server renders crawlable HTML at clean URLs — `/in/delhi`, `/in/delhi/comedy-shows`, `/in/delhi/comedy-shows/this-weekend`, `/in/delhi/free`, `/e/<event-slug>-<id>` — with titles, descriptions, canonical URLs, Open Graph previews, schema.org `Event`/`ItemList`/`BreadcrumbList`, plus `/sitemap.xml` and `/robots.txt`. Pages with fewer than 2 events are `noindex`. Netlify proxies these paths to Railway (`public/_redirects`). Set `PUBLIC_URL` to your domain and submit `https://<domain>/sitemap.xml` in Google Search Console.

### Two kinds of events
- **Listed** (from Google Events): Funillion shows facts + links; booking happens on BookMyShow/District/etc. ("Book on … ↗"). Add affiliate links with `AFFILIATE_TEMPLATES`.
- **Ticketed on Funillion** (organisers who list with you): real checkout with Razorpay, QR e-tickets, refunds. Only these can be sold on Funillion.

### Payment flow
Server creates a Razorpay order → Razorpay Checkout collects UPI/card/netbanking → server verifies the HMAC signature → booking confirmed. A webhook confirms payments that arrive after the tab was closed; if the seats were released and sold meanwhile, the payment is **auto-refunded**. Cancellations refund via the Razorpay API (100% up to 24 h before, 50% after).

## Going live: what to swap in

1. **Real event sources:** write one adapter per platform in `server/aggregator.js` (`adapters.yourSource = row => ({ ...normalised })`) that reads their API or a partner feed. The deduper and merger work as they are. Scrape only sites whose terms allow it.
2. **Payments:** replace the `// DEMO GATEWAY` block in `server.js` (`/api/bookings/:id/pay`) with a Razorpay order + signature verification. Holds, inventory and refunds are already handled.
3. **LLM for the planner (optional):** set `ANTHROPIC_API_KEY`. Claude then reads the request first; the built-in parser remains the fallback. `FUNILLION_MODEL` picks the model.
4. **Database:** `server/db.js` is the only file that touches storage. Swap it for Postgres/SQLite when you need more than one server.
5. **Emails/SMS for tickets and reminders:** hook into the `pay` and `cancel` routes.

## Notes

- Events, organisers and the three sources (TicketHub, DevCircuit, MeetLocal) are demo data. The source URLs use `.example` domains.
- "Demo people" auto-accept friend requests and vote/chat in groups so the social features are alive from the first minute.
- The map tiles, Google Fonts and URL import need internet. Everything else works offline.
