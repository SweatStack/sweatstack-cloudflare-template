// /design: the design workbench. Every component in every state, and every real page rendered from
// demo data (src/fixtures). Change public/app.css, reload, and see everything at once.
//
// Open to everyone in local development (localhost); admin-only on a deployed app.
//   /design                  component gallery (?accent=%23e11d48 to try an accent; the sun/moon button switches theme)
//   /design/pages/<name>     a real page with demo data: landing, dashboard, activities, activity, settings, admin, setup

import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { ThemeForm } from "./settings";
import { DEMO_USER, demoActivities, demoActivityDetails } from "../fixtures";
import type { AppEnv } from "../env";
import { formatDayMonth } from "../lib/format";
import { weeklyTotals } from "../lib/series";
import { Layout } from "../views/Layout";
import {
  ActivityList,
  Attribution,
  Banner,
  Card,
  Chart,
  CheckItem,
  CopyField,
  Empty,
  ErrorBox,
  Icon,
  PageHeader,
  Pager,
  SectionLabel,
  SignInButton,
  StatGrid,
  StatTile,
} from "../views/components";
import { isLocalhost } from "./setup";

export const designRoutes = new Hono<AppEnv>();

/** Page previews: name → the real route that renders it. */
export const DEMO_PAGES: Record<string, { path: string; signedIn: boolean; unconfigured?: boolean }> = {
  landing: { path: "/", signedIn: false },
  dashboard: { path: "/", signedIn: true },
  activities: { path: "/activities", signedIn: true },
  activity: { path: "/activities/:demo", signedIn: true }, // the most recent demo activity
  analysis: { path: "/analysis?sport=cycling&metric=power&weeks=12", signedIn: true },
  settings: { path: "/settings", signedIn: true },
  admin: { path: "/admin", signedIn: true },
  setup: { path: "/setup", signedIn: false, unconfigured: true },
  privacy: { path: "/privacy", signedIn: false },
};

export const DEMO_SESSION_USER = { id: DEMO_USER.sub, name: DEMO_USER.name, isAdmin: true, createdAt: Date.now() - 5 * 60_000 };

/** /design is for local development, and for admins of a deployed app. */
export const designAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isLocalhost(new URL(c.req.url).origin) || c.var.user?.isAdmin) return next();
  return c.notFound();
};

designRoutes.get("/design", designAccess, (c) => {
  const activities = demoActivities();
  const weeks = weeklyTotals(activities, 12);
  const sample = demoActivityDetails(activities[1]!);

  return c.html(
    <Layout title="Design" user={c.var.user ?? DEMO_SESSION_USER} active="home">
      <PageHeader title="Design workbench" subtitle="Every component, in every state. Edit public/app.css and reload." />
      <div class="design-toolbar" data-design-toolbar>
        <ThemeForm current={(getCookie(c, "theme") as "light" | "dark" | undefined) ?? "system"} back="/design" />
        <span class="muted small">Accent</span>
        {["#2563eb", "#e11d48", "#059669", "#7c3aed", "#ea580c"].map((color) => (
          <a class="swatch" href={`?accent=${encodeURIComponent(color)}`} data-swatch={color} aria-label={`Accent ${color}`}></a>
        ))}
      </div>

      <SectionLabel>Pages with demo data</SectionLabel>
      <Card>
        <ul class="link-grid">
          {Object.keys(DEMO_PAGES).map((name) => (
            <li>
              <a href={`/design/pages/${name}`}>{name}</a>
            </li>
          ))}
        </ul>
      </Card>

      <SectionLabel>Buttons</SectionLabel>
      <Card>
        <div class="actions">
          <button class="btn btn-primary" type="button">Primary</button>
          <button class="btn btn-secondary" type="button">Secondary</button>
          <button class="btn btn-ghost" type="button">Ghost</button>
          <button class="btn btn-danger" type="button">Danger</button>
          <button class="btn btn-primary" type="button" disabled>Disabled</button>
          <button class="btn btn-secondary btn-small" type="button">Small</button>
          <button class="btn btn-primary" type="button"><Icon name="bell" /> With icon</button>
        </div>
        <div class="actions">
          <SignInButton />
        </div>
      </Card>

      <SectionLabel>Banners</SectionLabel>
      <Banner tone="info" title="Importing your training history…"><p>Info: something is happening.</p></Banner>
      <Banner tone="ok" title="Disconnected"><p>Success: it worked.</p></Banner>
      <Banner tone="warn" title="Placeholder"><p>Warning: needs attention.</p></Banner>
      <ErrorBox title="Couldn't reach SweatStack" message="This is usually temporary." requestId="8f2a9c1d4e5b6a70" retryHref="/design" />

      <SectionLabel>Stats</SectionLabel>
      <Card>
        <StatGrid>
          <StatTile label="Duration" value="1:32:10" />
          <StatTile label="Distance" value="48.3 km" />
          <StatTile label="Avg heart rate" value="139 bpm" />
          <StatTile label="Avg power" value="212 W" />
          <StatTile label="Avg speed" value="31.5 km/h" />
          <StatTile label="Elevation gain" value="508 m" />
        </StatGrid>
        <Attribution text="Garmin" />
      </Card>

      <SectionLabel>Charts</SectionLabel>
      <Card>
        <Chart
          type="bars"
          label="Training time per week"
          summary="Training time per week (demo data)."
          data={{
            labels: weeks.map((w) => formatDayMonth(w.weekStart)),
            series: [{ label: "Training time", unit: "h", color: "accent", values: weeks.map((w) => +(w.seconds / 3600).toFixed(2)) }],
          }}
        />
      </Card>
      <Card>
        <Chart
          type="stack"
          label="Power, heart rate and speed over time"
          summary="Demo timeseries: power as AISC steps, heart rate and speed as lines."
          data={{
            series: [
              { label: "Power", unit: "W", color: "power", average: "214 W", stepped: true, ...steps(150, 300) },
              { label: "Heart rate", unit: "bpm", color: "hr", average: "141 bpm", ...wave(120, 160, 0) },
              { label: "Speed", unit: "km/h", color: "speed", average: "31.2 km/h", ...wave(26, 36, 2) },
            ],
          }}
        />
      </Card>

      <SectionLabel>Activity list</SectionLabel>
      <Card class="card-flush">
        <ActivityList activities={activities.slice(0, 4)} />
      </Card>
      <Pager page={2} hasOlder={true} hrefFor={(p) => `/design?page=${p}`} />

      <SectionLabel>Empty state</SectionLabel>
      <Card>
        <Empty title="No activities yet">
          <p class="muted">Connect the service you record your training with.</p>
        </Empty>
      </Card>

      <SectionLabel>Forms and checklist</SectionLabel>
      <Card>
        <CopyField id="design-copy" label="Redirect URI" value="https://your-app.example.workers.dev/" />
        <ul class="checklist">
          <CheckItem ok={true} title="Done">
            <p class="muted">Something that is set up.</p>
          </CheckItem>
          <CheckItem ok={false} title="To do">
            <p>Something that still needs doing.</p>
          </CheckItem>
          <CheckItem ok={null} title="Optional" />
        </ul>
        <p>
          Badges: <span class="badge badge-ok">set</span> <span class="badge badge-todo">missing</span>{" "}
          <span class="badge badge-notified">notified</span> <span class="badge badge-skipped">skipped</span>{" "}
          <span class="badge badge-failed">failed</span>
        </p>
        <p>
          Sample for the detail page: <a href={`/design/pages/activity`}>{sample.id}</a>
        </p>
      </Card>
    </Layout>,
  );
});

/** Demo AISC-like segments: flat steps of varying length, with one pause (null). */
function steps(min: number, max: number) {
  const x: number[] = [];
  const values: Array<number | null> = [];
  let t = 0;
  for (let i = 0; t < 3600; i++) {
    x.push(t);
    values.push(i === 14 ? null : Math.round(min + (max - min) * (0.5 + 0.45 * Math.sin(i * 1.7))));
    t += 60 + ((i * 97) % 240);
  }
  x.push(3600);
  values.push(values.at(-1) ?? null);
  return { x, values };
}

/** A smooth demo series for the line chart. */
function wave(min: number, max: number, phase: number) {
  const x: number[] = [];
  const values: number[] = [];
  for (let t = 0; t <= 3600; t += 15) {
    x.push(t);
    values.push(Math.round(min + (max - min) * (0.5 + 0.35 * Math.sin(t / 420 + phase) + 0.15 * Math.sin(t / 97))));
  }
  return { x, values };
}
