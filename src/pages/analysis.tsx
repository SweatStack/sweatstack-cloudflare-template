// /analysis: time in zone and the metabolic profile, for one root sport and one metric.
//   /analysis?sport=cycling&metric=power&weeks=12
//
// Sport and metric are required: a missing or invalid value redirects to a canonical URL with defaults,
// so every view is a plain, bookmarkable link. The results load as an htmx fragment (/analysis/results):
// the page shows at once, and a slow analysis never takes it down.
//
// Time in zone uses AISC-segmented longitudinal data: one row per segment of steady intensity, with its
// duration. Summing segment durations per zone is exact for the segment means and 20-50x cheaper than
// per-second data. Zones and the metabolic map are SweatStack's (beta): https://docs.sweatstack.no/learn/data/metabolic-profile/

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { requireUser } from "../auth/session";
import type { AppEnv } from "../env";
import { formatDuration, formatHours, formatSport } from "../lib/format";
import { timeInZones } from "../lib/series";
import { toNumber } from "../sweatstack/parquet";
import { SweatStackError } from "../sweatstack/http";
import type { MetabolicMap, MarkerValue, Zone, ZoneMetric, ZonesResponse } from "../sweatstack/types";
import { Layout } from "../views/Layout";
import { Attribution, Banner, Card, Chart, Empty, PageHeader, SectionLabel } from "../views/components";

export const analysisRoutes = new Hono<AppEnv>();

const PERIODS = [4, 12, 26] as const;
const DEFAULT_WEEKS = 12;

const METRIC_LABELS: Record<ZoneMetric, string> = { power: "Power", heart_rate: "Heart rate", speed: "Pace" };

/** The metrics SweatStack has zones for, per root sport: power for cycling and running, speed (pace) for running. */
export function metricsForSport(sport: string): ZoneMetric[] {
  if (sport === "cycling") return ["power", "heart_rate"];
  if (sport === "running") return ["power", "heart_rate", "speed"];
  return ["heart_rate"];
}

type Selection = { sport: string; metric: ZoneMetric; weeks: number };

/** Validates the query against what's possible; returns the canonical selection. */
function select(query: Record<string, string>, sports: string[]): Selection | null {
  const sport = sports.includes(query.sport ?? "") ? query.sport! : sports[0];
  if (!sport) return null;
  const metrics = metricsForSport(sport);
  const metric = metrics.includes(query.metric as ZoneMetric) ? (query.metric as ZoneMetric) : metrics[0]!;
  const weeks = PERIODS.includes(Number(query.weeks) as (typeof PERIODS)[number]) ? Number(query.weeks) : DEFAULT_WEEKS;
  return { sport, metric, weeks };
}

function href(path: string, s: Selection): string {
  return `${path}?${new URLSearchParams({ sport: s.sport, metric: s.metric, weeks: String(s.weeks) })}`;
}

analysisRoutes.get("/analysis", requireUser, async (c) => {
  const sports = await c.var.sweatstack().getSports();
  const selection = select(c.req.query(), sports);
  if (!selection) {
    return c.html(
      <Layout title="Analysis" user={c.var.user} active="analysis">
        <PageHeader title="Analysis" />
        <Card>
          <Empty title="Nothing to analyse yet">
            <p class="muted">Once you have activities, this page shows your time in each training zone.</p>
          </Empty>
        </Card>
      </Layout>,
    );
  }
  const canonical = href("/analysis", selection);
  const url = new URL(c.req.url);
  if (url.pathname + url.search !== canonical) return c.redirect(canonical);

  return c.html(
    <Layout title="Analysis" user={c.var.user} active="analysis">
      <PageHeader title="Analysis" subtitle="Time in zone and your metabolic profile." />
      <form class="filter-bar" method="get" action="/analysis">
        <div class="filter">
          <label for="sport">Sport</label>
          <select id="sport" name="sport" data-autosubmit>
            {sports.map((s) => (
              <option value={s} selected={s === selection.sport}>
                {formatSport(s)}
              </option>
            ))}
          </select>
        </div>
        <div class="filter">
          <label for="weeks">Period</label>
          <select id="weeks" name="weeks" data-autosubmit>
            {PERIODS.map((w) => (
              <option value={String(w)} selected={w === selection.weeks}>
                Last {w} weeks
              </option>
            ))}
          </select>
        </div>
        {/* Kept when the sport changes; the server falls back to the sport's first metric if it doesn't apply. */}
        <input type="hidden" name="metric" value={selection.metric} />
        <button class="btn btn-secondary btn-small js-hide" type="submit">
          Apply
        </button>
      </form>
      <nav class="segmented" aria-label="Metric">
        {metricsForSport(selection.sport).map((metric) => (
          <a href={href("/analysis", { ...selection, metric })} aria-current={metric === selection.metric ? "page" : undefined}>
            {METRIC_LABELS[metric]}
          </a>
        ))}
      </nav>
      <div hx-get={href("/analysis/results", selection)} hx-trigger="load" hx-swap="outerHTML" data-chart-slot class="analysis-slot">
        <Card>
          <p class="muted">Loading analysis…</p>
        </Card>
      </div>
    </Layout>,
  );
});

/** Fragment: time in zone and metabolic profile for one selection. */
analysisRoutes.get("/analysis/results", requireUser, async (c) => {
  const sweatstack = c.var.sweatstack();
  const selection = select(c.req.query(), [c.req.query("sport") ?? ""].filter((s) => /^[a-z_]+$/.test(s)));
  if (!selection) return c.html(<></>);
  const { sport, metric, weeks } = selection;

  const start = new Date(Date.now() - weeks * 7 * 86400_000).toISOString().slice(0, 10);
  // AISC segments on power or speed. Heart-rate time in zone uses whichever the sport records reliably.
  const segmentationOn = metric === "heart_rate" ? (sport === "cycling" ? "power" : "speed") : metric;
  const withVo2 = sport === "cycling" || sport === "running";

  const [zones, data, map, vo2] = await Promise.all([
    settle(sweatstack.getZones(metric, sport)),
    settle(sweatstack.getLongitudinalData({ sport: [sport], metrics: [metric], start, segmentationOn })),
    settle(sweatstack.getMetabolicMap(metric, sport)),
    withVo2 ? settle(sweatstack.getMetabolicMap("vo2", sport)) : Promise.resolve(null),
  ]);
  if (data.error && !(data.error instanceof SweatStackError && data.error.isNotFound)) throw data.error;

  const values = (data.value?.columns[metric] ?? []).map(toNumber);
  const durations = (data.value?.columns.duration ?? []).map((d) => toNumber(d) ?? 0); // seconds, for segments
  const activityIds = data.value?.columns.activity_id ?? [];
  const activities = new Set(activityIds.filter((_, i) => values[i] !== null)).size;

  return c.html(
    <div class="analysis-results">
      <SectionLabel>Time in zone</SectionLabel>
      {zones.value ? (
        <TimeInZone zones={zones.value} values={values} durations={durations} metric={metric} weeks={weeks} activities={activities} />
      ) : (
        <Card>
          <ProfileProblem error={zones.error} />
        </Card>
      )}
      <SectionLabel>Metabolic profile</SectionLabel>
      <Card>
        {map.value ? <Markers map={map.value} metric={metric} vo2={vo2?.value ?? null} /> : <ProfileProblem error={map.error} />}
        <p class="muted small">
          Estimated by SweatStack from your training, tests and settings. "Estimated" values reflect what you've shown in
          training, so they rise when you train hard.
        </p>
      </Card>
      <Attribution text={data.value?.attribution} />
    </div>,
  );
});

/** Awaits a promise, keeping either its value or its error (so one failing call doesn't fail the page). */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

const TimeInZone: FC<{ zones: ZonesResponse; values: (number | null)[]; durations: number[]; metric: ZoneMetric; weeks: number; activities: number }> = ({
  zones,
  values,
  durations,
  metric,
  weeks,
  activities,
}) => {
  const result = timeInZones(values, durations, zones.zones);
  if (result.total === 0) {
    return (
      <Card>
        <Empty title="No data for this period">
          <p class="muted">
            None of your {METRIC_LABELS[metric].toLowerCase()} data in the last {weeks} weeks could be used.
          </p>
        </Empty>
      </Card>
    );
  }
  const rows = zones.zones.map((zone, i) => ({ zone, seconds: result.seconds[i] ?? 0 }));
  const labels = [...rows.map((r) => r.zone.name), ...(result.above > 0 ? ["Above"] : [])];
  const hours = [...rows.map((r) => r.seconds), ...(result.above > 0 ? [result.above] : [])].map((s) => +(s / 3600).toFixed(2));

  return (
    <Card>
      <p class="muted small">
        {formatHours(result.total)} over {activities} {activities === 1 ? "activity" : "activities"} in the last {weeks} weeks.
      </p>
      <Chart
        type="bars"
        label="Time in each zone"
        summary={rows.map((r) => `${r.zone.name} ${r.zone.label}: ${formatHours(r.seconds)}`).join(". ")}
        data={{ labels, series: [{ label: "Time", unit: "h", color: metric === "heart_rate" ? "hr" : metric, values: hours }] }}
      />
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Zone</th>
              <th scope="col">Range</th>
              <th scope="col">Time</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ zone, seconds }) => (
              <tr>
                <td>
                  {zone.name} <span class="muted">{zone.label}</span>
                </td>
                <td class="num">{formatZoneRange(zone, metric)}</td>
                <td class="num">{formatHours(seconds)}</td>
                <td class="num">{Math.round((seconds / result.total) * 100)}%</td>
              </tr>
            ))}
            {result.above > 0 && (
              <tr>
                <td>Above zones</td>
                <td class="num">–</td>
                <td class="num">{formatHours(result.above)}</td>
                <td class="num">{Math.round((result.above / result.total) * 100)}%</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
};

/** "207–248 W", "≥ 450 W", "4:20–4:54 /km" (pace: higher speed is faster, so the order flips). */
export function formatZoneRange(zone: Zone, metric: ZoneMetric): string {
  if (metric === "speed") {
    const pace = (speed: number) => `${formatDuration(1000 / speed)}`;
    if (zone.upper === null) return `faster than ${pace(zone.lower)} /km`;
    if (zone.lower <= 0) return `slower than ${pace(zone.upper)} /km`;
    return `${pace(zone.upper)}–${pace(zone.lower)} /km`;
  }
  const unit = metric === "power" ? "W" : "bpm";
  if (zone.upper === null) return `≥ ${Math.round(zone.lower)} ${unit}`;
  return `${Math.round(zone.lower)}–${Math.round(zone.upper)} ${unit}`;
}

const MARKERS: Record<ZoneMetric, Array<{ key: string; label: string; unit: "W" | "bpm" | "pace" | "kJ" | "m" }>> = {
  power: [
    { key: "second_threshold", label: "Threshold (FTP)", unit: "W" },
    { key: "critical_power", label: "Critical power", unit: "W" },
    { key: "w_prime", label: "W′ (work capacity above CP)", unit: "kJ" },
    { key: "max_aerobic_power", label: "Maximal aerobic power", unit: "W" },
    { key: "first_threshold", label: "Aerobic threshold", unit: "W" },
  ],
  speed: [
    { key: "second_threshold", label: "Threshold pace", unit: "pace" },
    { key: "critical_speed", label: "Critical speed", unit: "pace" },
    { key: "d_prime", label: "D′ (distance capacity above CS)", unit: "m" },
    { key: "max_aerobic_speed", label: "Maximal aerobic speed", unit: "pace" },
    { key: "first_threshold", label: "Aerobic threshold", unit: "pace" },
  ],
  heart_rate: [
    { key: "heart_rate_max", label: "Max heart rate", unit: "bpm" },
    { key: "second_threshold", label: "Threshold heart rate", unit: "bpm" },
    { key: "first_threshold", label: "Aerobic threshold", unit: "bpm" },
  ],
};

const PROVENANCE: Record<MarkerValue["provenance"], string> = {
  modeled: "estimated",
  measured: "from a test",
  declared: "set by you",
  external: "from a device",
};

const Markers: FC<{ map: MetabolicMap; metric: ZoneMetric; vo2: MetabolicMap | null }> = ({ map, metric, vo2 }) => {
  const rows = MARKERS[metric].flatMap(({ key, label, unit }) => {
    const marker = map[key];
    return marker ? [{ label, value: formatMarker(marker.value, unit), provenance: marker.provenance }] : [];
  });
  const vo2max = vo2?.vo2max_relative ?? null;
  if (vo2max) rows.push({ label: "VO2max", value: `${vo2max.value.toFixed(1)} mL/kg/min`, provenance: vo2max.provenance });
  if (rows.length === 0) return <p class="muted">No markers yet for this sport.</p>;
  return (
    <dl class="markers">
      {rows.map((row) => (
        <div class="marker">
          <dt>{row.label}</dt>
          <dd>
            <span class="num">{row.value}</span> <span class="badge">{PROVENANCE[row.provenance]}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
};

function formatMarker(value: number, unit: "W" | "bpm" | "pace" | "kJ" | "m"): string {
  if (unit === "pace") return `${formatDuration(1000 / value)} /km`;
  if (unit === "kJ") return `${value.toFixed(1)} kJ`;
  return `${Math.round(value)} ${unit}`;
}

/** Friendly text for the expected "not enough data yet" states of zones and the metabolic map. */
const ProfileProblem: FC<{ error: unknown }> = ({ error }) => {
  const code = error instanceof SweatStackError ? error.code : undefined;
  const messages: Record<string, string> = {
    insufficient_data: "Not enough recent training yet: this needs at least one activity of 15 minutes or longer in the last 90 days.",
    missing_body_mass: "Add your body mass in SweatStack to see this: power and speed markers are scaled by it.",
    missing_heart_rate_max: "Set your maximum heart rate in SweatStack to see heart-rate zones.",
    missing_resting_hr: "Heart-rate zones need a resting heart rate from the last 7 days. Sync a device that measures it.",
    unusable_heart_rate_range: "Your maximum and resting heart rates don't leave a usable range. Check them in SweatStack.",
  };
  if (code && messages[code]) return <p class="muted">{messages[code]}</p>;
  if (error instanceof SweatStackError && error.status < 500 && error.status !== 0) {
    return <p class="muted">Not available for this sport.</p>;
  }
  return (
    <Banner tone="error">
      <p>Couldn't load this from SweatStack right now. Try again in a moment.</p>
    </Banner>
  );
};
