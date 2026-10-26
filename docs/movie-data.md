# Movie listings and live ticket offers

`/#/movies` works with the user's selected Indian city. Without credentials it shows a nearby cinema directory from OpenStreetMap, directions and links to search for current shows. Directory coverage is incomplete, and a cinema on the map is not evidence of a current film or showtime. Counts describe cinemas found within the chosen radius, not a census of the entire city.

## Live showtimes: MovieGlu

Set `MOVIEGLU_CLIENT`, `MOVIEGLU_API_KEY`, and `MOVIEGLU_AUTHORIZATION` as Railway service variables using credentials licensed for **India**. The app fixes territory to `IN`; sandbox listings are never presented as live Indian inventory.

The adapter reads `cinemasNearby` (up to 25), then `cinemaShowTimes` for the nearest eight cinemas by default. `MOVIEGLU_MAX_CINEMAS` can raise this to 25 within your request allowance. Only films with future showtimes at those cinemas enter the movie dropdown. Partial coverage is labelled. After-midnight shows before 03:00 belong to the preceding cinema business date.

Booking calls `purchaseConfirmation` for the selected film, cinema, service date and time, then redirects to the cinema. Seat selection, final inventory, payment and booking confirmation happen on that partner's website. This is not the Funillion event checkout. MovieGlu's documented showtimes response does not contain ticket prices, so these shows say **Price on partner site**.

Nearby cinema queries and purchase confirmation are never cached. `MOVIEGLU_DAILY_LIMIT` caps requests per server process; use provider-side account spending controls for multiple processes or restarts. Timeouts, rate limits and partial failures produce visible unavailable/partial states.

Official documentation: [headers](https://developer.movieglu.com/v2/api-index/setup/), [nearby cinemas](https://developer.movieglu.com/v2/api-index/cinemasNearby/), [cinema schedules](https://developer.movieglu.com/v2/api-index/cinemaShowTimes/), [booking handoff](https://developer.movieglu.com/v2/api-index/purchaseconfirmation/).

## Live prices: a booking partner feed

To compare actual offers, connect an authorized cinema/booking partner endpoint with `MOVIES_FEED_URL` and optional `MOVIES_FEED_TOKEN`. This feed takes precedence over MovieGlu. It must include the movies, cinemas and shows to display, with stable IDs shared by all arrays. It receives a server-to-server HTTPS GET with query parameters:

`city`, `date` (`YYYY-MM-DD`, Indian cinema business date), `lat`, `lng`, `radiusKm`.

The bearer token is sent in the Authorization header. Redirects are not followed. A valid response has this shape; the sample below is **integration data only**, not real movie inventory:

```json
{
  "source": "Your licensed booking partner",
  "city": "surat",
  "date": "YYYY-MM-DD",
  "updatedAt": "ISO timestamp when this schedule was verified",
  "partial": true,
  "cinemas": [{ "id": "cinema-1", "name": "Cinema name", "address": "Address", "lat": 21.17, "lng": 72.83 }],
  "movies": [{ "id": "film-1", "title": "Film title", "image": "https://licensed.example/poster.jpg", "rating": "UA", "synopsis": "Optional synopsis" }],
  "showtimes": [{
    "id": "show-1", "movieId": "film-1", "cinemaId": "cinema-1",
    "startsAt": "YYYY-MM-DDT19:30:00+05:30", "language": "Hindi", "format": "2D",
    "bookingUrl": "https://your-booking-partner.example/show-1",
    "offers": [{
      "id": "offer-1", "provider": "Partner name", "seatClass": "Classic",
      "currency": "INR", "price": 200, "fees": 25, "feesIncluded": false,
      "availableTickets": 4, "available": true,
      "checkedAt": "ISO timestamp", "expiresAt": "ISO timestamp",
      "bookingUrl": "https://your-booking-partner.example/show-1"
    }]
  }]
}
```

`updatedAt` and offer `checkedAt` must be no more than 15 minutes old or one minute in the future. Offers require an explicit future `expiresAt`, INR prices and an allowed HTTPS booking host. `price` and `fees` are **per ticket**. With `feesIncluded: true`, `price` is the final per-ticket total; otherwise `fees` is added. `fees: null` means unknown checkout fees: do not convert it to zero. `availableTickets` is optional; when present, it limits the offered quantity. Omit a sold-out offer or set `available: false`.

Add the real partner's hostname to `MOVIES_BOOKING_HOSTS`. Only exact hosts and their subdomains are accepted. These values are server configuration, never user-controlled URLs.

The UI labels the lowest **listed ticket price among the filtered results**, not the cheapest ticket across the internet. Smart picks weigh listed price (65%) and straight-line distance (35%). Language, format, movie and budget filters apply first. Total-budget matching requires known fees and multiplies the per-ticket total by group size. Seat classes are shown because different seats can cost different amounts. Booking re-fetches the schedule and checks price, expiry and quantity; a changed price requires the user to review refreshed offers. Prices are not reserved by Funillion.

## Optional AI

Set `ANTHROPIC_API_KEY` and `MOVIES_AI_MODEL` to an available model ID for natural language preference extraction. The model extracts total budget, party size, language, format, time-of-day and sorting preference. It receives the user's preference text, not their coordinates, and cannot create film listings, showtimes, offers or booking URLs. A built-in English/Hinglish parser works without credentials and remains the fallback. AI is not active without this configuration.

## Directory and location

`MOVIES_OVERPASS_URL` can select a hosted/self-hosted Overpass endpoint. The default uses the VK Maps public instance listed in [OpenStreetMap's endpoint directory](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances). Map results are cached for six hours with a bounded cache. Location is optional; without it, distances use the selected city centre. Device coordinates are sent only after the user clicks **Use my location** and grants browser permission, and are used to query the configured data provider. They are not saved to the Funillion user profile.

Run `node --test tests/cities-movies.test.js` for directory, routing, data freshness, pricing, provider contract and booking checks. The integration suite uses synthetic responses and makes no paid API requests. Real showtimes and booking cannot be verified until the live provider credentials are configured.
