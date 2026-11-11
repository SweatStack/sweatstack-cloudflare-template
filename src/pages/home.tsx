// "/": the landing page when signed out, the dashboard when signed in.
// Also /partials/last-activity: the htmx fragment that refreshes the last-activity card when the app
// comes back into view (see public/app.js, "app:visible").

import { Hono, type Context } from "hono";
import type { FC } from "hono/jsx";
import { APP } from "../app.config";
import type { AppEnv } from "../env";
import { formatDistance, formatDuration, formatHours, formatNumber, formatSpeed, parseDuration, activityTitle, formatDayMonth } from "../lib/format";
import { trendStartDate, weeklyTotals, type WeekTotal } from "../lib/series";
import { getAppState } from "../state";
import type { ActivityDetails, BackfillStatus } from "../sweatstack/types";
import { Layout } from "../views/Layout";
import {
  ActivityHeading,
  Attribution,
  Banner,
  Card,
  Chart,
  CopyField,
  Empty,
  Icon,
  SectionLabel,
  SignInButton,
  sportIcon,
  StatGrid,
  StatTile,
} from "../views/components";
import { requireUser } from "../auth/session";
import { deploymentUrls } from "./setup";

export const homeRoutes = new Hono<AppEnv>();

/** Show the "importing your history" banner only in a user's first minutes, while recent history is still arriving. */
const IMPORT_BANNER_MS = 15 * 60 * 1000;

homeRoutes.get("/", async (c) => {
  if (!c.var.user) return renderLanding(c);

  const sweatstack = c.var.sweatstack();
  const isNewUser = Date.now() - c.var.user.createdAt < IMPORT_BANNER_MS;
  const [latest, recent, backfill] = await Promise.all([
    sweatstack.getLatestActivity(),
    // One request for the whole trend window. 1000 is far more than anyone trains in 12 weeks.
    sweatstack.listActivities({ start: trendStartDate(APP.trendWeeks), limit: 1000 }),
    isNewUser ? sweatstack.getBackfillStatus().catch(() => null) : Promise.resolve(null),
  ]);

  return c.html(
    <Dashboard
      latest={latest}
      weeks={weeklyTotals(recent, APP.trendWeeks)}
      // Only while some history has arrived: with no activities at all, the empty state explains what to do.
      importing={isNewUser && latest !== null && stillImporting(backfill)}
      attributions={[latest?.attribution, ...recent.map((a) => a.attribution)]}
      c={c}
    />,
  );
});

homeRoutes.get("/partials/last-activity", requireUser, async (c) => {
  const latest = await c.var.sweatstack().getLatestActivity();
  return c.html(<LastActivity activity={latest} />);
});

function stillImporting(status: BackfillStatus | null): boolean {
  if (!status) return false;
  if (!status.backfill_loaded_until) return true; // nothing imported yet
  const trendStart = new Date(`${trendStartDate(APP.trendWeeks)}T00:00:00Z`).getTime();
  return new Date(status.backfill_loaded_until).getTime() > trendStart;
}

// --- Signed out ------------------------------------------------------------------------------

async function renderLanding(c: Context<AppEnv>) {
  const state = await getAppState(c.env.DB);
  const urls = deploymentUrls(c);
  return c.html(
    <Layout title={APP.name}>
      {c.req.query("signed_out") && (
        <Banner tone="info" title="You've been signed out">
          <p>Your SweatStack connection ended. Sign in again to continue.</p>
        </Banner>
      )}
      {c.req.query("disconnected") && (
        <Banner tone="ok" title="Disconnected">
          <p>This app no longer stores anything about you. You can also review connected apps in your SweatStack account.</p>
        </Banner>
      )}
      <section class="hero">
        <img class="hero-icon" src="/icons/logo.svg" alt="" width="88" height="88" />
        <h1>Your training, at a glance.</h1>
        <p class="lead">
          See your latest session, your weekly training time and the heart rate and power behind every activity. Get a
          notification the moment a new one syncs.
        </p>
        <SignInButton />
      </section>

      {!state.first_login_at && (
        <Card title="Finish setup" class="card-setup">
          <p>
            One step left: add this redirect URI to your app on the OAuth tab in{" "}
            <a href="https://app.sweatstack.no/settings/api">SweatStack</a>, then sign in.
          </p>
          <CopyField id="redirect-uri" label="Redirect URI" value={urls.redirectUri} />
          <p class="muted small">This panel disappears after the first successful sign-in.</p>
        </Card>
      )}
    </Layout>,
  );
}

// --- Signed in -------------------------------------------------------------------------------

const Dashboard: FC<{
  latest: ActivityDetails | null;
  weeks: WeekTotal[];
  importing: boolean;
  attributions: Array<string | null | undefined>;
  c: Context<AppEnv>;
}> = ({ latest, weeks, importing, attributions, c }) => {
  const user = c.var.user;
  const thisWeek = weeks[weeks.length - 1]?.seconds ?? 0;
  // Average over completed weeks: the current week is still in progress.
  const completed = weeks.slice(0, -1);
  const average = completed.reduce((sum, w) => sum + w.seconds, 0) / Math.max(1, completed.length);

  return (
    <Layout title="Home" user={user} active="home">
      <h1 class="visually-hidden">Home</h1>
      {importing && (
        <Banner tone="info" title="Importing your training history…">
          <p>Your recent activities are already here. Older ones keep arriving over the next few minutes.</p>
        </Banner>
      )}

      <SectionLabel>Last activity</SectionLabel>
      <LastActivity activity={latest} />

      <SectionLabel>Last {APP.trendWeeks} weeks</SectionLabel>
      <Card>
        <div class="trend-summary">
          <div>
            <p class="muted small">This week</p>
            <p class="figure num">{formatHours(thisWeek)}</p>
          </div>
          <div>
            <p class="muted small">Weekly average</p>
            <p class="figure num">{formatHours(average)}</p>
          </div>
        </div>
        <Chart
          type="bars"
          label={`Training time per week, last ${APP.trendWeeks} weeks`}
          summary={`Training time per week. This week ${formatHours(thisWeek)}, average ${formatHours(average)}.`}
          data={{
            labels: weeks.map((w) => formatDayMonth(w.weekStart)),
            series: [{ label: "Training time", unit: "h", color: "accent", values: weeks.map((w) => +(w.seconds / 3600).toFixed(2)) }],
          }}
        />
      </Card>
      <Attribution text={attributions} />
    </Layout>
  );
};

/** The last-activity card. Wrapped so htmx can swap the whole card (hx-swap="outerHTML"). */
export const LastActivity: FC<{ activity: ActivityDetails | null }> = ({ activity }) => (
  <div id="last-activity" hx-get="/partials/last-activity" hx-trigger="app:visible from:body" hx-swap="outerHTML">
    {activity ? <LastActivityCard activity={activity} /> : <NoActivities />}
  </div>
);

const LastActivityCard: FC<{ activity: ActivityDetails }> = ({ activity }) => {
  const s = activity.summary;
  return (
    <a class="card card-link" href={`/activities/${encodeURIComponent(activity.id)}`}>
      <div class="card-head">
        <span class="sport-badge sport-badge-large">
          <Icon name={sportIcon(activity.sport)} />
        </span>
        <div>
          <p class="card-heading">{activityTitle(activity)}</p>
          <ActivityHeading activity={activity} />
        </div>
      </div>
      <StatGrid>
        <StatTile label="Duration" value={formatDuration(parseDuration(activity.duration))} />
        <StatTile label="Distance" value={formatDistance(s?.distance?.sum)} />
        <StatTile label="Avg heart rate" value={formatNumber(s?.heart_rate?.mean, "bpm")} />
        <StatTile label="Avg power" value={formatNumber(s?.power?.mean, "W")} />
        {!s?.power?.mean && <StatTile label="Avg speed" value={formatSpeed(s?.speed?.mean, activity.sport)} />}
      </StatGrid>
      <div class="card-foot">
        <span class="link-label">
          View activity <Icon name="chevron" />
        </span>
      </div>
    </a>
  );
};

const NoActivities: FC = () => (
  <Card>
    <Empty title="No activities yet">
      <p class="muted">Connect the service you record your training with, and your activities show up here.</p>
      <form method="post" action="/settings/data-sources">
        <input type="hidden" name="standalone" value="0" data-standalone />
        <button class="btn btn-primary" type="submit">
          Connect a data source
        </button>
      </form>
    </Empty>
  </Card>
);
