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
  seed.js              generates the 3 demo source feeds + demo people
  aggregator.js        adapters → normalise → dedupe (blocking + fuzzy scoring) → merge
  feed.js              For You ranking, trending shelves, Fun Score
  planner.js           Hinglish parser + itinerary optimiser (depth-first search with budget/time/travel constraints)
  importer.js          URL → event draft (JSON-LD / Open Graph), with private-network protection
  auth.js              scrypt password hashing, HttpOnly session cookies
  db.js                JSON file store (atomic writes)
public/                single-page app (vanilla JS modules), Leaflet map, QR codes
data/                  created on first run (db.json + sources/*.json)
```


## Production setup (Railway)

Set these in **Railway → service → Variables** (full list with comments in `.env.example`). Never put keys in the code — the repo is on GitHub.

| Variable | What it does |
|---|---|
| `SERPAPI_KEY` | Turns on **real events** for all cities from Google Events (BookMyShow, District, AllEvents, Insider…). First pull runs ~3 s after deploy, then every 7 days. |
| `ADMIN_EMAILS` | Your Funillion login email → you get the **"Pull real events now"** button (Organizer → Smart aggregation). |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Real checkout. Use **test keys** (`rzp_test_…`) until real organisers list real events. Without keys the demo gateway is used. |
| `RAZORPAY_WEBHOOK_SECRET` | Confirms bookings even if the buyer closes the tab after paying; tracks refunds. |
| `ALLOWED_ORIGINS` | Your Netlify/custom domains (login breaks with 403 without it). |

On Railway, demo data is **off by default**: the first deploy removes all fake events and demo people (Meera & co.) and keeps real accounts.

**Razorpay webhook:** Dashboard → Settings → Webhooks → Add: URL `https://<railway-domain>/api/razorpay/webhook`, events `payment.captured`, `order.paid`, `refund.processed`, `refund.failed`, secret = `RAZORPAY_WEBHOOK_SECRET`.

### Funillion crawler (free real events, all cities)
`server/crawler/` reads public event pages on AllEvents, District, Eventbrite, Townscript, Luma, Unstop and Devfolio (list in `server/crawler/sites.js`), every 12 h:
1. checks each site's **robots.txt** (skips anything disallowed, honours Crawl-delay) and identifies itself as `FunillionBot`
2. opens the city listing pages + event sitemaps, then the event pages (one request at a time per site, ≥1.5 s apart; a site that keeps refusing is left alone)
3. reads the **schema.org Event** data sites publish for search engines — title, date/time, venue, geo, price — and keeps only upcoming, in-person events in our 14 cities
4. hands them to the aggregator, which merges the same event from different sites into one listing with every booking link
5. remembers pages it has read, so later runs only fetch new/stale pages

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
