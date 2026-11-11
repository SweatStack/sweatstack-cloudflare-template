// The typed SweatStack API client. Every call to SweatStack's API goes through here.
//
//   const sweatstack = c.var.sweatstack();          // in a route, for the signed-in user
//   const activities = await sweatstack.listActivities({ limit: 20 });
//
// The client gets a valid access token for each call (refreshing it when needed), retries a
// request once with a fresh token on 401, and retries GETs once on transient errors.
//
// Calling a new endpoint? Add a method here and its types to ./types.ts. Look up the exact
// parameters and response shape in https://app.sweatstack.no/openapi.json instead of guessing.

import { errorFrom, fetchWithRetry, SweatStackError, SWEATSTACK_URL, type Fetch } from "./http";
import { readColumns, toMillis, toNumber } from "./parquet";
import type {
  ActivityDetails,
  ActivitySummary,
  BackfillStatus,
  MetabolicMap,
  Metric,
  PortalDestination,
  Timeseries,
  UserInfo,
  ZoneMetric,
  ZonesResponse,
} from "./types";

export type GetToken = (options?: { forceRefresh?: boolean }) => Promise<string>;

type Query = Record<string, string | number | boolean | readonly string[] | null | undefined>;

export class SweatStackClient {
  constructor(
    private readonly fetchFn: Fetch,
    private readonly getToken: GetToken,
  ) {}

  // --- Activities -----------------------------------------------------------------------------

  /** Activities, newest first. `sport` matches the sport and its sub-sports ("cycling" includes "cycling.road"). */
  listActivities(options: {
    limit?: number;
    offset?: number;
    sport?: string | null;
    start?: string; // YYYY-MM-DD
    end?: string; // YYYY-MM-DD
  }): Promise<ActivitySummary[]> {
    const { sport, ...rest } = options;
    return this.json("/api/v1/activities/", { ...rest, sport: sport ? [sport] : undefined });
  }

  getActivity(id: string): Promise<ActivityDetails> {
    return this.json(`/api/v1/activities/${encodeURIComponent(id)}`);
  }

  /** The most recent activity, or null when the user has none yet. */
  async getLatestActivity(): Promise<ActivityDetails | null> {
    try {
      return await this.json<ActivityDetails>("/api/v1/activities/latest");
    } catch (error) {
      if (error instanceof SweatStackError && error.isNotFound) return null;
      throw error;
    }
  }

  /**
   * The timeseries of one activity, decoded from Parquet. Ask only for the metrics you use: it keeps
   * the download and the decoding (Worker CPU time) small.
   *
   * `segmentationOn` ("power" or "speed") asks SweatStack for AISC-segmented data: one row per segment
   * of steady intensity instead of one per second, 20-50x smaller with the shape preserved. Use it for
   * charts and overviews; leave it out when you need every sample (for example, your own calculations).
   * https://docs.sweatstack.no/learn/data/activities/#activity-data
   */
  async getActivityData(id: string, metrics: readonly Metric[], options: { segmentationOn?: "power" | "speed" } = {}): Promise<Timeseries> {
    const response = await this.request(`/api/v1/activities/${encodeURIComponent(id)}/data`, {
      query: { metrics, segmentation_on: options.segmentationOn },
      accept: "application/vnd.apache.parquet, application/octet-stream",
    });
    const attribution = response.headers.get("SweatStack-Attribution");
    const segmented = options.segmentationOn !== undefined;
    const raw = await readColumns(await response.arrayBuffer(), ["timestamp", ...(segmented ? ["duration"] : []), ...metrics]);

    const timestamps = (raw.timestamp ?? []).map(toMillis);
    const first = timestamps.find((t) => t !== null) ?? 0;
    const columns: Timeseries["columns"] = {};
    for (const metric of metrics) {
      const values = raw[metric];
      if (values && values.some((v) => v !== null)) columns[metric] = values.map(toNumber);
    }
    return {
      elapsed: timestamps.map((t) => (t === null ? 0 : (t - first) / 1000)),
      // Segment durations are served in whole seconds (a Parquet duration with unit "s").
      durations: segmented ? (raw.duration ?? []).map((d) => toNumber(d) ?? 0) : null,
      columns,
      attribution,
    };
  }

  /**
   * Timeseries across many activities in one request, decoded from Parquet. Every row has an
   * `activity_id`, `timestamp` and `timestamp_local` column next to the metrics. Use this for trends
   * and distributions instead of looping over getActivityData().
   */
  async getLongitudinalData(options: {
    metrics: readonly Metric[];
    sport?: string[];
    start: string; // YYYY-MM-DD
    end?: string; // YYYY-MM-DD
    /**
     * AISC segments instead of samples (see getActivityData). Each row is then a segment, and `duration`
     * is in whole seconds. Activities without segments for this metric are left out of the result.
     */
    segmentationOn?: "power" | "speed";
  }): Promise<{ columns: Record<string, unknown[]>; attribution: string | null }> {
    const response = await this.request("/api/v1/activities/longitudinal-data", {
      query: {
        metrics: options.metrics,
        sport: options.sport,
        start: options.start,
        end: options.end,
        segmentation_on: options.segmentationOn,
      },
      accept: "application/vnd.apache.parquet, application/octet-stream",
    });
    return {
      columns: await readColumns(await response.arrayBuffer()),
      attribution: response.headers.get("SweatStack-Attribution"),
    };
  }

  /**
   * How far back the user's history has been imported. The endpoint streams progress for up to a
   * minute; we read the first update and stop.
   */
  async getBackfillStatus(): Promise<BackfillStatus | null> {
    const response = await this.request("/api/v1/activities/backfill-status", { accept: "application/x-ndjson" });
    const firstLine = await readFirstLine(response);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as Partial<BackfillStatus> & { error?: string };
    return parsed.error ? null : { backfill_loaded_until: parsed.backfill_loaded_until ?? null };
  }

  // --- Profile ----------------------------------------------------------------------------------

  getUserInfo(): Promise<UserInfo> {
    return this.json("/api/v1/oauth/userinfo");
  }

  /** The sports this user has activities for, e.g. ["cycling", "running"] (root sports only). */
  getSports(): Promise<string[]> {
    return this.json("/api/v1/profile/sports/", { only_root: true });
  }

  // --- Profile: zones and metabolic map (beta) ----------------------------------------------------
  // https://docs.sweatstack.no/learn/data/metabolic-profile/ . Expected states (a new athlete without
  // enough data) come back as errors with a `code`, e.g. "insufficient_data", "missing_resting_hr".

  /** Training zones for a root sport. power: cycling or running. speed: running. heart_rate: any root sport. */
  getZones(metric: ZoneMetric, sport: string): Promise<ZonesResponse> {
    return this.json(`/api/v1/profile/zones/${metric}`, { sport });
  }

  /** The athlete's markers (thresholds, critical power, VO2max…) for a root sport, each with its provenance. */
  getMetabolicMap(metric: ZoneMetric | "vo2", sport: string): Promise<MetabolicMap> {
    return this.json(`/api/v1/profile/metabolic-map/${metric}`, { sport });
  }

  // --- Portal (beta) ----------------------------------------------------------------------------

  /**
   * A one-time link to the SweatStack Portal, where users connect and manage their data sources.
   * Create it when the user clicks, and redirect straight to it. `returnUrl` must sit under one of
   * the app's registered redirect URIs. https://docs.sweatstack.no/learn/portal/
   */
  async createPortalSession(destination: PortalDestination, returnUrl?: string): Promise<string> {
    const response = await this.request("/api/v1/portal/sessions", {
      method: "POST",
      body: { destination, ...(returnUrl ? { return_url: returnUrl } : {}) },
    });
    const { url } = (await response.json()) as { url: string };
    return url;
  }

  // --- Plumbing ---------------------------------------------------------------------------------

  private async json<T>(path: string, query?: Query): Promise<T> {
    const response = await this.request(path, query ? { query } : {});
    return (await response.json()) as T;
  }

  private async request(
    path: string,
    options: { query?: Query; method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown; accept?: string },
  ): Promise<Response> {
    const method = options.method ?? "GET";
    const url = buildUrl(path, options.query);
    const send = async (token: string) =>
      fetchWithRetry(
        this.fetchFn,
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: options.accept ?? "application/json",
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        },
        { retry: method === "GET" },
      );

    let response = await send(await this.getToken());
    if (response.status === 401) {
      // The token was rejected before its expiry (revoked, or rotated elsewhere): refresh and try once more.
      response = await send(await this.getToken({ forceRefresh: true }));
    }
    if (!response.ok) throw await errorFrom(response, `${method} ${path}`);
    return response;
  }
}

function buildUrl(path: string, query: Query = {}): string {
  const url = new URL(path, SWEATSTACK_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    // Arrays become repeated params (?metrics=power&metrics=heart_rate), as SweatStack expects.
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function readFirstLine(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const line = text.split("\n")[0]?.trim();
  return line || null;
}
