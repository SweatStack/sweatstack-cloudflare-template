// Realistic, synthetic SweatStack data, used in two places:
//   - /design renders every page from it (no account or data needed)
//   - the tests use it as SweatStack's responses
// Keep it realistic: the tests depend on it, and so does the design workbench.

import activityParquet from "./activity-data.parquet";
import activitySegmentsParquet from "./activity-segments.parquet";
import longitudinalCycling from "./longitudinal-cycling.parquet";
import longitudinalRunning from "./longitudinal-running.parquet";
import longitudinalSwimming from "./longitudinal-swimming.parquet";
import { parseDuration } from "../lib/format";
import type { Fetch } from "../sweatstack/http";
import type { ActivityDetails, ActivitySummary, MetabolicMap, UserInfo, ZonesResponse } from "../sweatstack/types";

export const DEMO_USER: UserInfo = { sub: "demo-athlete", name: "Demo Athlete" };

type Template = { sport: string; minutes: number; km: number | null; hr: number; power?: number; hour: number; attribution: string | null };

/** A typical training week, Monday first. Null = rest day. */
const WEEK: Array<Template | null> = [
  null,
  { sport: "running", minutes: 46, km: 9.2, hr: 148, hour: 7, attribution: "Garmin" },
  { sport: "cycling.road", minutes: 92, km: 48.3, hr: 139, power: 212, hour: 18, attribution: "Garmin" },
  { sport: "running", minutes: 61, km: 11.8, hr: 152, hour: 12, attribution: "Garmin" },
  { sport: "swimming", minutes: 40, km: 2.1, hr: 131, hour: 7, attribution: null },
  { sport: "cycling.road", minutes: 154, km: 78.6, hr: 135, power: 198, hour: 9, attribution: "Garmin" },
  { sport: "running", minutes: 101, km: 19.4, hr: 145, hour: 10, attribution: "Garmin" },
];

const pad = (n: number) => String(n).padStart(2, "0");

function isoDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

/** About 12 weeks of activities, newest first, ending today. Deterministic for a given `now`. */
export function demoActivities(now = new Date(), weeks = 13): ActivitySummary[] {
  const activities: ActivitySummary[] = [];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let daysAgo = 0; daysAgo < weeks * 7; daysAgo++) {
    const day = new Date(today - daysAgo * 86400_000);
    const template = WEEK[(day.getUTCDay() + 6) % 7];
    if (!template) continue;
    const variation = 1 + (((daysAgo * 37) % 11) - 5) / 50; // ±10%, deterministic
    const seconds = Math.round(template.minutes * 60 * variation);
    const date = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    const startLocal = `${date}T${pad(template.hour)}:${pad((daysAgo * 7) % 60)}:00`;
    const start = new Date(new Date(`${startLocal}Z`).getTime() - 3600_000); // athlete is at UTC+1
    const distance = template.km === null ? null : Math.round(template.km * 1000 * variation);
    activities.push({
      id: `demo-${pad(activities.length)}`, // demo-00 is always the newest
      sport: template.sport,
      start: start.toISOString().replace(".000", ""),
      end: new Date(start.getTime() + seconds * 1000).toISOString().replace(".000", ""),
      start_local: startLocal,
      duration: isoDuration(seconds),
      metrics: [
        "heart_rate",
        "distance",
        "speed",
        ...(template.power ? (["power"] as const) : []),
        ...(template.sport === "swimming" ? [] : (["cadence"] as const)),
        ...(template.sport.startsWith("cycling") ? (["altitude"] as const) : []),
      ],
      summary: {
        heart_rate: { mean: Math.round(template.hr * variation), max: Math.round(template.hr * variation + 24) },
        distance: distance === null ? null : { sum: distance },
        speed: distance === null ? null : { mean: distance / seconds, max: (distance / seconds) * 1.4 },
        power: template.power ? { mean: Math.round(template.power * variation), max: Math.round(template.power * 3.1) } : null,
        altitude: template.sport.startsWith("cycling") ? { gain: Math.round(distance! / 95) } : null,
      },
      attribution: template.attribution,
    });
  }
  return activities;
}

export function demoActivityDetails(activity: ActivitySummary): ActivityDetails {
  const seconds = parseDuration(activity.duration) ?? 1800;
  const half = Math.round(seconds / 2);
  const lap = (index: number) => ({
    start: activity.start,
    start_local: activity.start_local,
    duration: isoDuration(half),
    distance: activity.summary?.distance?.sum ? { sum: Math.round(activity.summary.distance.sum / 2) } : null,
    heart_rate: { mean: (activity.summary?.heart_rate?.mean ?? 140) + (index ? 6 : -4) },
    power: activity.summary?.power?.mean ? { mean: activity.summary.power.mean + (index ? 12 : -10) } : null,
    speed: activity.summary?.speed ?? null,
  });
  return { ...activity, laps: [lap(0), lap(1)], devices: ["Demo watch"] };
}

/** Root sports in the demo data, as GET /profile/sports/?only_root=true returns them. */
export const DEMO_SPORTS = ["running", "cycling", "swimming"];

const LONGITUDINAL: Record<string, ArrayBuffer> = { cycling: longitudinalCycling, running: longitudinalRunning, swimming: longitudinalSwimming };

const zone = (name: string, label: string, lower: number, upper: number | null) => ({ name, label, lower, upper });
export const DEMO_ZONES: Record<string, ZonesResponse> = {
  "power/cycling": {
    zone_system: "seven_zone",
    zones: [zone("Z1", "Active recovery", 0, 152), zone("Z2", "Endurance", 152, 207), zone("Z3", "Tempo", 207, 248), zone("Z4", "Threshold", 248, 290), zone("Z5", "VO2max", 290, 330), zone("Z6", "Anaerobic", 330, 450), zone("Z7", "Sprint", 450, null)],
  },
  "power/running": {
    zone_system: "seven_zone",
    zones: [zone("Z1", "Active recovery", 0, 180), zone("Z2", "Endurance", 180, 230), zone("Z3", "Tempo", 230, 265), zone("Z4", "Threshold", 265, 300), zone("Z5", "VO2max", 300, 335), zone("Z6", "Anaerobic", 335, 420), zone("Z7", "Sprint", 420, null)],
  },
  "speed/running": {
    zone_system: "five_zone",
    zones: [zone("Z1", "Recovery", 0, 2.9), zone("Z2", "Endurance", 2.9, 3.4), zone("Z3", "Tempo", 3.4, 3.85), zone("Z4", "Threshold", 3.85, 4.25), zone("Z5", "VO2max", 4.25, 4.7)],
  },
  "heart_rate/*": {
    zone_system: "five_zone",
    zones: [zone("Z1", "Recovery", 0, 131), zone("Z2", "Endurance", 131, 144), zone("Z3", "Tempo", 144, 157), zone("Z4", "Threshold", 157, 170), zone("Z5", "VO2max", 170, null)],
  },
};

const marker = (value: number, provenance: "modeled" | "measured" | "declared" | "external" = "modeled") => ({ value, provenance });
export const DEMO_MAPS: Record<string, MetabolicMap> = {
  "power/cycling": { fatmax: marker(168), first_threshold: marker(168), second_threshold: marker(276, "measured"), critical_power: marker(289), max_aerobic_power: marker(335), w_prime: marker(18.3), mlss: marker(272, "measured"), lt1: null, lt2: null, vt1: null, vt2: null },
  "power/running": { fatmax: marker(205), first_threshold: marker(205), second_threshold: marker(282), critical_power: marker(295), max_aerobic_power: marker(338), w_prime: marker(12.1), mlss: null, lt1: null, lt2: null, vt1: null, vt2: null },
  "speed/running": { fatmax: marker(3.12), first_threshold: marker(3.12), second_threshold: marker(4.02), critical_speed: marker(4.16), max_aerobic_speed: marker(4.62), d_prime: marker(205), mlss: null, lt1: null, lt2: null, vt1: null, vt2: null },
  "heart_rate/*": { heart_rate_max: marker(188, "declared"), first_threshold: null, second_threshold: marker(169, "external"), mlss: null, lt1: null, lt2: null, vt1: null, vt2: null },
  "vo2/cycling": { vo2max: marker(4120), vo2max_relative: marker(57.2) },
  "vo2/running": { vo2max: marker(4050), vo2max_relative: marker(56.3) },
};

/**
 * A fake SweatStack API (activities, profile, portal) served from the demo data. Pass it where the app
 * expects `fetch`. Requests it doesn't know get a 404.
 */
export function demoSweatStackFetch(now = new Date()): Fetch {
  const activities = demoActivities(now);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/v1/oauth/userinfo") return json(DEMO_USER);
    if (path === "/api/v1/profile/sports/") return json(DEMO_SPORTS);
    if (path === "/api/v1/portal/sessions" && request.method === "POST") return json({ url: "https://app.sweatstack.no/portal/integrations?demo=1" });
    if (path === "/api/v1/activities/backfill-status") {
      return new Response(`${JSON.stringify({ backfill_loaded_until: "2019-03-01T00:00:00Z" })}\n`, { headers: { "content-type": "application/x-ndjson" } });
    }
    if (path === "/api/v1/activities/latest") return json(demoActivityDetails(activities[0]!));
    if (path === "/api/v1/activities/longitudinal-data") {
      const sport = (url.searchParams.get("sport") ?? "").split(/[.+]/)[0]!;
      const data = LONGITUDINAL[sport];
      return data ? parquet(data) : json({ detail: "No demo data for this sport" }, 404);
    }
    const profile = /^\/api\/v1\/profile\/(zones|metabolic-map)\/(\w+)$/.exec(path);
    if (profile) {
      const [, kind, metric] = profile;
      const sport = url.searchParams.get("sport") ?? "";
      // Swimming has no resting heart rate in the demo account: shows the "missing data" state.
      if (sport === "swimming") return problem("missing_resting_hr", "No resting heart rate in the last 7 days.");
      const table = kind === "zones" ? DEMO_ZONES : DEMO_MAPS;
      const found = table[`${metric}/${sport}`] ?? table[`${metric}/*`];
      return found ? json(found) : json({ detail: "Unsupported sport for this metric" }, 422);
    }
    if (path === "/api/v1/activities/") {
      const sport = url.searchParams.get("sport");
      const start = url.searchParams.get("start");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const matching = activities.filter(
        (a) => (!sport || a.sport === sport || a.sport.startsWith(`${sport}.`) || a.sport.startsWith(`${sport}+`)) && (!start || a.start_local.slice(0, 10) >= start),
      );
      return json(matching.slice(offset, offset + limit));
    }
    const data = /^\/api\/v1\/activities\/([^/]+)\/data$/.exec(path);
    if (data) {
      if (!activities.some((a) => a.id === decodeURIComponent(data[1]!))) return json({ detail: "Not found" }, 404);
      return parquet(url.searchParams.has("segmentation_on") ? activitySegmentsParquet : activityParquet);
    }
    const one = /^\/api\/v1\/activities\/([^/]+)$/.exec(path);
    if (one) {
      const activity = activities.find((a) => a.id === decodeURIComponent(one[1]!));
      return activity ? json(demoActivityDetails(activity)) : json({ detail: "Not found" }, 404);
    }
    return json({ detail: `Not in demo data: ${request.method} ${path}` }, 404);
  };
}

function parquet(data: ArrayBuffer): Response {
  return new Response(data.slice(0), { headers: { "content-type": "application/octet-stream", "SweatStack-Attribution": "Garmin" } });
}

function problem(code: string, detail: string): Response {
  return new Response(JSON.stringify({ type: "about:blank", title: detail, status: 422, code, detail }), {
    status: 422,
    headers: { "content-type": "application/problem+json" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
