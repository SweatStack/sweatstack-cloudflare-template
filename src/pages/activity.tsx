// /activities/:id: one activity. Summary stats as tiles, then every recorded metric over time (stacked
// charts, loaded as an htmx fragment), then laps. Attribution once, at the bottom.

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { requireUser } from "../auth/session";
import type { AppEnv } from "../env";
import {
  activityTitle,
  formatDistance,
  formatDuration,
  formatNumber,
  formatSpeed,
  parseDuration,
  usesPace,
} from "../lib/format";
import { CHART_METRICS, formatMetricValue, metricDisplay, toDisplayValue } from "../lib/metrics";
import { downsample, steppedSeries } from "../lib/series";
import { SweatStackError } from "../sweatstack/http";
import type { ActivityDetails, Lap, Timeseries } from "../sweatstack/types";
import { Layout } from "../views/Layout";
import { ActivityHeading, Attribution, Card, Chart, PageHeader, SectionLabel, StatGrid, StatTile } from "../views/components";
import { parseSport } from "./activities";

export const activityRoutes = new Hono<AppEnv>();

type ChartMetric = (typeof CHART_METRICS)[number];

/** Points per line for per-second data (AISC segments are already compact and are never downsampled). */
const CHART_POINTS = 600;

activityRoutes.get("/activities/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  const activity = await c.var.sweatstack().getActivity(id);
  const metrics = chartMetrics(activity.metrics);
  const chartUrl = `/activities/${encodeURIComponent(id)}/chart?sport=${encodeURIComponent(activity.sport)}&metrics=${metrics.join(",")}`;

  return c.html(
    <Layout title={activityTitle(activity)} user={c.var.user} active="activities">
      <PageHeader title={activityTitle(activity)} subtitle={<ActivityHeading activity={activity} />} back={{ href: "/activities", label: "Activities" }} />
      <Stats activity={activity} />
      {metrics.length > 0 && (
        <>
          <SectionLabel>Over time</SectionLabel>
          {/* The chart loads as a separate htmx fragment: the page shows at once, and a slow or failed
              chart never takes the rest of the page down with it. */}
          <div class="card chart-slot" hx-get={chartUrl} hx-trigger="load" hx-swap="outerHTML" data-chart-slot>
            <p class="muted">Loading chart…</p>
          </div>
        </>
      )}
      <Laps laps={activity.laps ?? []} sport={activity.sport} />
      <Attribution text={activity.attribution} />
    </Layout>,
  );
});

/**
 * Fragment: every metric of one activity over time, one chart per metric, stacked.
 *
 * It asks for AISC-segmented data (segmentation_on): one row per segment of steady intensity, 20-50x
 * smaller than per-second data, so it's quick to download and decode even for long activities. Each
 * segment's mean is drawn as a flat step over the segment's duration. Activities without power or speed
 * (or without segments) fall back to per-second data, drawn as a line.
 */
activityRoutes.get("/activities/:id/chart", requireUser, async (c) => {
  const id = c.req.param("id");
  const sport = parseSport(c.req.query("sport")) ?? "";
  const metrics = chartMetrics((c.req.query("metrics") ?? "").split(","));
  if (metrics.length === 0) return c.html(<></>);
  const sweatstack = c.var.sweatstack();

  const segmentationOn = metrics.includes("power") ? "power" : metrics.includes("speed") ? "speed" : undefined;
  try {
    let timeseries: Timeseries;
    try {
      timeseries = await sweatstack.getActivityData(id, metrics, segmentationOn ? { segmentationOn } : {});
    } catch (error) {
      if (!segmentationOn || !(error instanceof SweatStackError) || error.status >= 500 || error.status === 0) throw error;
      timeseries = await sweatstack.getActivityData(id, metrics); // no segments for this activity
    }
    return c.html(<TimeseriesCharts timeseries={timeseries} sport={sport} />);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", requestId: c.var.requestId, message: "Activity data failed", error: String(error) }));
    return c.html(
      <div class="card">
        <p class="muted">The chart couldn't be loaded right now.</p>
      </div>,
    );
  }
});

function chartMetrics(available: readonly string[]): ChartMetric[] {
  return CHART_METRICS.filter((metric) => available.includes(metric));
}

const Stats: FC<{ activity: ActivityDetails }> = ({ activity }) => {
  const s = activity.summary;
  return (
    <StatGrid>
      <StatTile label="Duration" value={formatDuration(parseDuration(activity.duration))} />
      <StatTile label="Distance" value={formatDistance(s?.distance?.sum)} />
      <StatTile label={usesPace(activity.sport) ? "Avg pace" : "Avg speed"} value={formatSpeed(s?.speed?.mean, activity.sport)} />
      <StatTile label="Elevation gain" value={formatNumber(s?.altitude?.gain, "m")} />
      <StatTile label="Avg heart rate" value={formatNumber(s?.heart_rate?.mean, "bpm")} />
      <StatTile label="Max heart rate" value={formatNumber(s?.heart_rate?.max, "bpm")} />
      <StatTile label="Avg power" value={formatNumber(s?.power?.mean, "W")} />
      <StatTile label="Max power" value={formatNumber(s?.power?.max, "W")} />
      <StatTile label="Avg cadence" value={formatNumber(s?.cadence?.mean, "rpm")} />
    </StatGrid>
  );
};

const TimeseriesCharts: FC<{ timeseries: Timeseries; sport: string }> = ({ timeseries, sport }) => {
  const { elapsed, durations } = timeseries;
  const series = CHART_METRICS.flatMap((metric) => {
    const raw = timeseries.columns[metric];
    if (!raw) return [];
    const display = metricDisplay(metric, sport);
    const values = raw.map((v) => toDisplayValue(metric, v, display.pace));
    const points = durations
      ? steppedSeries(elapsed, durations, values)
      : (([x, y]) => ({ x, values: y as Array<number | null> }))(downsample(elapsed, values, CHART_POINTS));
    const present = points.values.filter((v): v is number => v !== null);
    if (present.length < 2) return [];
    const mean = durations ? weightedMean(values, durations) : present.reduce((a, b) => a + b, 0) / present.length;
    return [
      {
        ...display,
        average: formatMetricValue(mean, display),
        stepped: durations !== null,
        x: points.x.map((t) => Math.round(t)),
        values: points.values.map((v) => (v === null ? null : Math.round(v * 10) / 10)),
        mean,
      },
    ];
  });
  if (series.length === 0) return <div class="card"><p class="muted">No chartable data for this activity.</p></div>;

  const summary = series.map((s) => `${s.label}: average ${formatMetricValue(s.mean, s)}`).join(". ");
  return (
    <Card>
      <Chart
        type="stack"
        label={`${series.map((s) => s.label).join(", ")} over the activity`}
        summary={`${summary}.`}
        data={{ series: series.map(({ mean: _mean, ...s }) => s) }}
      />
    </Card>
  );
};

/** Mean of segment values weighted by segment duration. */
function weightedMean(values: readonly (number | null)[], durations: readonly number[]): number {
  let sum = 0;
  let total = 0;
  values.forEach((v, i) => {
    if (v === null) return;
    sum += v * (durations[i] ?? 0);
    total += durations[i] ?? 0;
  });
  return total ? sum / total : 0;
}

const Laps: FC<{ laps: Lap[]; sport: string }> = ({ laps, sport }) =>
  laps.length < 2 ? null : (
    <>
      <SectionLabel>Laps</SectionLabel>
      <Card class="card-flush">
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Lap</th>
                <th scope="col">Time</th>
                <th scope="col">Distance</th>
                <th scope="col">{usesPace(sport) ? "Pace" : "Speed"}</th>
                <th scope="col">Avg HR</th>
                <th scope="col">Avg power</th>
              </tr>
            </thead>
            <tbody>
              {laps.map((lap, i) => (
                <tr>
                  <td>{i + 1}</td>
                  <td class="num">{formatDuration(parseDuration(lap.duration))}</td>
                  <td class="num">{formatDistance(lap.distance?.sum) ?? "–"}</td>
                  <td class="num">{formatSpeed(lap.speed?.mean, sport) ?? "–"}</td>
                  <td class="num">{formatNumber(lap.heart_rate?.mean, "bpm") ?? "–"}</td>
                  <td class="num">{formatNumber(lap.power?.mean, "W") ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
