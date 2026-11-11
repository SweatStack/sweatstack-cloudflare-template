// /activities/:id: one activity. Summary stats as tiles, a timeseries chart from the Parquet data
// (heart rate, power, speed: whichever the activity has), and laps.

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
import { downsample } from "../lib/series";
import type { ActivityDetails, Lap, Metric, Timeseries } from "../sweatstack/types";
import { Layout } from "../views/Layout";
import { ActivityHeading, Attribution, Card, Chart, PageHeader, SectionLabel, StatGrid, StatTile } from "../views/components";

export const activityRoutes = new Hono<AppEnv>();

/** The chartable metrics, in the order the chart offers them. */
const CHART_METRICS = [
  { metric: "heart_rate", label: "Heart rate", unit: "bpm", color: "hr" },
  { metric: "power", label: "Power", unit: "W", color: "power" },
  { metric: "speed", label: "Speed", unit: "km/h", color: "speed" },
] as const satisfies ReadonlyArray<{ metric: Metric; label: string; unit: string; color: string }>;

/** Points per chart line: plenty for a phone or laptop screen, small enough to send in the page. */
const CHART_POINTS = 600;

activityRoutes.get("/activities/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  const sweatstack = c.var.sweatstack();
  const activity = await sweatstack.getActivity(id);

  const metrics = CHART_METRICS.filter((m) => activity.metrics.includes(m.metric)).map((m) => m.metric);
  let timeseries: Timeseries | null = null;
  let chartError = false;
  if (metrics.length > 0) {
    try {
      timeseries = await sweatstack.getActivityData(id, metrics);
    } catch (error) {
      // The rest of the page is still useful without the chart.
      chartError = true;
      console.error(JSON.stringify({ level: "error", requestId: c.var.requestId, message: "Activity data failed", error: String(error) }));
    }
  }

  return c.html(
    <Layout title={activityTitle(activity)} user={c.var.user} active="activities">
      <PageHeader title={activityTitle(activity)} subtitle={<ActivityHeading activity={activity} />} back={{ href: "/activities", label: "Activities" }} />
      <Stats activity={activity} />
      <Attribution text={activity.attribution} />
      {timeseries && <TimeseriesChart timeseries={timeseries} sport={activity.sport} />}
      {chartError && (
        <Card>
          <p class="muted">The chart couldn't be loaded right now.</p>
        </Card>
      )}
      <Laps laps={activity.laps ?? []} sport={activity.sport} />
    </Layout>,
  );
});

const Stats: FC<{ activity: ActivityDetails }> = ({ activity }) => {
  const s = activity.summary;
  return (
    <StatGrid>
      <StatTile label="Duration" value={formatDuration(parseDuration(activity.duration))} />
      <StatTile label="Distance" value={formatDistance(s?.distance?.sum)} />
      <StatTile label={usesPace(activity.sport) ? "Avg pace" : "Avg speed"} value={formatSpeed(s?.speed?.mean, activity.sport)} tone="speed" />
      <StatTile label="Elevation gain" value={formatNumber(s?.altitude?.gain, "m")} />
      <StatTile label="Avg heart rate" value={formatNumber(s?.heart_rate?.mean, "bpm")} tone="hr" />
      <StatTile label="Max heart rate" value={formatNumber(s?.heart_rate?.max, "bpm")} tone="hr" />
      <StatTile label="Avg power" value={formatNumber(s?.power?.mean, "W")} tone="power" />
      <StatTile label="Max power" value={formatNumber(s?.power?.max, "W")} tone="power" />
      <StatTile label="Avg cadence" value={formatNumber(s?.cadence?.mean, "rpm")} />
    </StatGrid>
  );
};

const TimeseriesChart: FC<{ timeseries: Timeseries; sport: string }> = ({ timeseries }) => {
  const series = CHART_METRICS.flatMap(({ metric, label, unit, color }) => {
    const values = timeseries.columns[metric];
    if (!values) return [];
    const scaled = metric === "speed" ? values.map((v) => (v === null ? null : v * 3.6)) : values;
    const [x, y] = downsample(timeseries.elapsed, scaled, CHART_POINTS);
    if (x.length < 2) return [];
    const mean = y.reduce((sum, v) => sum + v, 0) / y.length;
    return [{ label, unit, color, x: x.map((t) => Math.round(t)), values: y.map((v) => Math.round(v * 10) / 10), mean }];
  });
  if (series.length === 0) return null;

  const summary = series.map((s) => `${s.label}: average ${Math.round(s.mean)} ${s.unit}`).join(". ");
  return (
    <>
      <SectionLabel>Over time</SectionLabel>
      <Card>
        <Chart
          type="line"
          label={`${series.map((s) => s.label).join(", ")} over the activity`}
          summary={`${summary}.`}
          data={{ series: series.map(({ mean: _mean, ...s }) => s) }}
        />
        <Attribution text={timeseries.attribution} />
      </Card>
    </>
  );
};

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
