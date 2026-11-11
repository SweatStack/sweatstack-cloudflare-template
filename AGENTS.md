# AGENTS.md

Instructions for coding agents working on this app. Read this before changing code. Humans: see README.md.

## What this is

A SweatStack app on Cloudflare Workers: Sign in with SweatStack, training data pages, an installable PWA, and push
notifications driven by SweatStack webhooks. One Worker (Hono) and one D1 database. Pages are rendered on the server.

## Rules

- **Keep server-rendered HTML + htmx.** Do not add React, Preact, Vue, Svelte, Alpine, Next.js, Remix, Astro, Tailwind,
  an ORM, an auth library, a UI kit, or a bundler (Vite, webpack). Wrangler is the only build tool. Only add one of these
  if the user explicitly asks for it.
- **All SweatStack API calls go through `src/sweatstack/client.ts`.** Never `fetch` SweatStack in a route. Never handle
  tokens in a route: `c.var.sweatstack()` gives you an authenticated client for the signed-in user.
- **Never guess SweatStack field names, parameters or enum values.** Look them up in
  https://app.sweatstack.no/openapi.json (or https://docs.sweatstack.no/llms.txt) and add only what you use to `types.ts`.
- **Pages render `<Layout>`; htmx fragments never do.** A fragment lives in the same file as the page that uses it.
- **No inline `<script>`, no `style="..."`, no `hx-on`.** The Content-Security-Policy blocks them. Behaviour goes in
  `public/app.js`; styling goes in `public/app.css` (use the tokens at the top).
- **Every htmx interaction must also work as a plain link or form** (except charts and push, which need JS).
- **Show attribution next to SweatStack data** whenever the response carries it (`attribution` field, or
  `Timeseries.attribution`): `<Attribution text={activity.attribution} />`. Garmin requires it.
- Treat every `summary` field as nullable. Show local times from `start_local`; compare and sort on `start`.
- Keep files small, with one concern each. Prefer explicit code over abstractions.

## Map

| Path | What |
|---|---|
| `src/index.ts` | App entry: middleware order, mounts every route, error handling |
| `src/app.config.ts` | App name, OAuth scopes, page size: settings a fork changes in code |
| `src/pages/*.tsx` | One file per page (+ its fragments): `home`, `activities`, `activity`, `settings`, `admin`, `setup`, `legal`, `design`, `errors` |
| `src/views/components.tsx` | Shared components (Card, StatTile, Chart, Banner, …). `Layout.tsx`: the page shell |
| `src/sweatstack/` | `client.ts` (API), `types.ts`, `oauth.ts`, `http.ts` (errors, retries), `parquet.ts` |
| `src/config.ts`, `src/secrets.ts`, `src/state.ts` | Worker secrets → config; self-generated keys; small facts in D1 |
| `src/<feature>.ts` | Put a non-page module (e.g. D1 helpers for a new table) at this level, like `state.ts` |
| `src/lib/` | Pure helpers: `crypto.ts`, `format.ts` (units, dates, sport names), `series.ts` (downsampling, weekly totals) |
| `src/auth/` | Sign-in routes, session cookie, token store with refresh-token rotation |
| `src/push/`, `src/webhooks/` | Web Push (send to a user's devices), SweatStack webhook receiver |
| `src/fixtures/` | Demo data: used by `/design` and by the tests |
| `public/` | Static files: `app.css`, `app.js`, `training-chart.js`, `sw.js`, icons, vendored libraries |
| `migrations/` | D1 schema, one numbered SQL file per change |
| `content/` | Privacy policy and terms (Markdown) |
| `test/` | Vitest in the Workers runtime; `helpers.ts` has a fake SweatStack and a signed-in test app |

## Recipes

**Add a page.** Copy `src/pages/settings.tsx` (simple) or `src/pages/activities.tsx` (data + query params). Export a
`Hono<AppEnv>` router, protect it with `requireUser`, render `<Layout title user active>`, and mount it in
`src/index.ts` with `app.route("/", yourRoutes)`. For a nav link, add the page to `NavItem` and a `<NavLink>` in
`src/views/Layout.tsx` (icons: `ICONS` in `components.tsx`, stroke paths on a 24px grid). Add a preview to `DEMO_PAGES` in
`src/pages/design.tsx` (the path may include a query string, e.g. to preview an error state), add it to the page list in
the `/design` route test, and add a route test.

**Add an htmx fragment.** Canonical: `/partials/last-activity` in `src/pages/home.tsx` (refreshes on `app:visible`) and
`/activities/:id/chart` in `src/pages/activity.tsx` (lazy load with `hx-trigger="load"`). Return a component without
`<Layout>`. Trigger on custom events (`hx-trigger="my-event from:body"`) dispatched from `public/app.js`, not on filter
expressions: those need eval, which the CSP blocks. A form that htmx enhances answers both ways:

```tsx
// <form method="post" action="/things/1/toggle" hx-post="/things/1/toggle" hx-swap="outerHTML">…</form>
routes.post("/things/:id/toggle", requireUser, async (c) => {
  const state = await toggleThing(c.env.DB, c.var.user!.id, c.req.param("id"));
  if (c.req.header("HX-Request")) return c.html(<ToggleForm id={c.req.param("id")} on={state} />); // htmx: the new fragment
  return c.redirect(`/things/${c.req.param("id")}`, 303); // plain form: back to the page
});
```

**Call a new SweatStack endpoint.** Find it in openapi.json: check required parameters and the response schema. Add a
method to `SweatStackClient` and the response type to `types.ts`, then use it from a route:

```ts
// src/sweatstack/client.ts: GET /api/v1/profile/zones/heart_rate needs `sport` (a root sport, e.g. "running")
getHeartRateZones(sport: string): Promise<HeartRateZones> {
  return this.json("/api/v1/profile/zones/heart_rate", { sport });
}
// src/pages/zones.tsx
try {
  zones = await c.var.sweatstack().getHeartRateZones("running");
} catch (error) {
  // Expected states come back as errors with a `code` (problem+json), e.g. "missing_resting_hr" for a new user.
  // Show a helpful message for those; let anything else reach the global error page.
  if (!(error instanceof SweatStackError && error.code)) throw error;
  missingReason = error.code;
}
```

Add the endpoint to `demoSweatStackFetch` in `src/fixtures/index.ts` so `/design` and the tests can render it.
New data category (wellness, workouts…)? See "Add a scope" first.

**Compute something from timeseries.** `getActivityData(id, ["heart_rate"])` returns columns (`elapsed` seconds and one
array per metric, nulls for gaps). For exact calculations, leave out `segmentationOn` (full 1 Hz data); for charts, pass
it (20-50x smaller). Decoding a multi-hour activity at 1 Hz can exceed the free plan's 10 ms CPU limit: load such work as
a lazy fragment (see the chart) or use Workers Paid. Across many activities, use `getLongitudinalData` (one request), not
a loop.

**Add a chart.** Render `<Chart type="line" | "bars" data={...} summary="text alternative" label="..." />` from
`components.tsx`. Line: `{ series: [{ label, unit, color: "hr" | "power" | "speed" | "accent", x: number[], values: number[] }] }`.
Bars: `{ labels: string[], series: [{ label, unit, color, values }] }`. Downsample long series with `downsample()` from
`src/lib/series.ts`. Don't add a second chart library.

**Add a D1 table.** Create `migrations/0002_<name>.sql` (never edit a migration that has been deployed). Run
`npm run db:migrate` locally; `npm run deploy` applies it in production; tests apply all migrations automatically. Use
`c.env.DB.prepare(...).bind(...)`; always bind values, never build SQL strings from input. Store times as epoch
milliseconds. **Per-user data must have `user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`**: Disconnect
promises to delete everything the app stores about a user. Put the queries in `src/<feature>.ts` (see `src/state.ts`).

**Send a different push notification.** Call `sendToUser(db, fetch, secrets, origin, userId, { title, body, url, tag })`
from `src/push/notify.ts`. To react to another webhook event, add a `case` in `handleEvent()` in
`src/webhooks/sweatstack.ts` (event types: `activity_created|updated|deleted`, `test_*`, `source_*`). Return quickly:
the receiver already acknowledges first and works in `waitUntil`. To test what a notification says, subscribe with
`subscribeForTest(userId)` and read `await pushMessages(sweatstack.calls)` (see `test/webhooks.test.ts`).

**Add a scope.** Add it to `APP.scopes` in `src/app.config.ts` (e.g. `wellness:read`), and tick it, with a purpose, on
the app's Consent screen tab in SweatStack. Existing users grant it the next time they sign in.

**Change the look.** Edit the tokens at the top of `public/app.css`; add component styles below them. Check `/design`
(every component and page; the sun/moon button switches theme; `?accent=%23e11d48` tries an accent). Previews only route
`hx-get` fragments to demo data: forms and `hx-post` in a preview hit the real routes.

**Write tests.** `testApp()` from `test/helpers.ts` gives `request()` (keeps cookies), `signIn()` and the fake SweatStack's
`calls`. Make one endpoint fail with `testApp({ onRequest: (r) => … })`. Demo data is pinned to `TEST_NOW` (a Wednesday;
`demo-00` is the newest activity). Rendered HTML escapes `'` as `&#39;`: assert on text without apostrophes.

## SweatStack facts

- Scopes are per category: `activities:read`, `wellness:read`, … plus `openid profile email offline_access`.
  `data:read`/`data:write` are retired and rejected for new apps. Don't send `prompt`.
- This is a confidential client (client secret, no PKCE: SweatStack ignores the secret on a PKCE flow). Access tokens
  last 15 minutes; refresh tokens rotate. `src/auth/tokens.ts` handles both. Don't reimplement refresh elsewhere.
- Activities have no name: use `activityTitle()` from `src/lib/format.ts`. Durations are ISO 8601 (`PT1H32M10S`):
  `parseDuration()`. Sports look like `cycling.road+stationary`: `formatSport()`.
- Timeseries endpoints return ZSTD Parquet; `client.ts` decodes it. Everything else is JSON.
- New apps are private (only the owner can sign in) until they go live.
- Docs: https://docs.sweatstack.no · API: https://app.sweatstack.no/docs · Skills:
  https://github.com/SweatStack/sweatstack-skills

## Commands

```sh
npm run dev          # local app on http://localhost:8787 (needs .dev.vars, see .dev.vars.example)
npm run typecheck    # TypeScript + check worker-configuration.d.ts is current (npm run types regenerates it)
npm test             # all tests, in the Workers runtime
npm run db:migrate   # apply migrations to the local database
npm run deploy       # migrate production and deploy
```

## Definition of done

1. `npm run typecheck` passes.
2. `npm test` passes, with tests for what you added (a route test at least; use `testApp()` from `test/helpers.ts`).
3. It works in `npm run dev`, and new pages look right on `/design` at phone width in light and dark mode.
4. No new dependency unless the user agreed to it. Pin exact versions.
