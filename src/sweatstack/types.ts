// SweatStack API types: only the fields this app uses. The full schemas are in
// https://app.sweatstack.no/openapi.json. Add fields here when you start using them;
// treat everything marked nullable as really nullable.

/** A metric name, as used by `metrics` query params and the `metrics` field on activities. */
export type Metric =
  | "duration"
  | "power"
  | "speed"
  | "heart_rate"
  | "cadence"
  | "altitude"
  | "elevation"
  | "distance"
  | "temperature"
  | "core_temperature"
  | "smo2"
  | "latitude"
  | "longitude"
  | "respiration_rate"
  | "lactate"
  | "rpe";

type Stat = number | null | undefined;

export type ActivityStats = {
  power?: { mean?: Stat; max?: Stat } | null;
  speed?: { mean?: Stat; max?: Stat } | null; // m/s
  distance?: { sum?: Stat } | null; // meters
  altitude?: { gain?: Stat; loss?: Stat; min?: Stat; max?: Stat } | null; // meters
  heart_rate?: { mean?: Stat; min?: Stat; max?: Stat } | null; // bpm
  cadence?: { mean?: Stat; max?: Stat } | null;
};

/** An activity as returned by GET /api/v1/activities/ (list). */
export type ActivitySummary = {
  id: string;
  /** OpenSportTaxonomy, e.g. "cycling.road", "running", "rowing+stationary". See lib/format.ts formatSport(). */
  sport: string;
  /** UTC instant, e.g. "2026-05-18T15:32:00Z". Use for sorting and comparing. */
  start: string;
  end: string;
  /** Local wall-clock without offset, e.g. "2026-05-18T17:32:00". Use for display and grouping by day. */
  start_local: string;
  /** ISO 8601 duration, e.g. "PT1H32M10S". */
  duration: string;
  metrics: Metric[];
  summary: ActivityStats | null;
  /**
   * The line to show next to this activity's data, e.g. "Garmin". Some platforms (Garmin) require it
   * wherever their data is displayed. Always render it when present: see views/components.tsx <Attribution>.
   */
  attribution?: string | null;
  tags?: string[];
};

export type Lap = ActivityStats & {
  start: string;
  start_local: string;
  duration: string;
};

/** An activity as returned by GET /api/v1/activities/{id} and /activities/latest. */
export type ActivityDetails = ActivitySummary & {
  laps?: Lap[] | null;
  devices?: string[];
};

/** Columns decoded from a Parquet timeseries. Missing metrics are absent; samples can be null. */
export type Timeseries = {
  /** Seconds since the start of the first row, one per row (a sample, or the start of a segment). */
  elapsed: number[];
  /**
   * AISC-segmented data only: how long each segment lasted, in seconds. A segment's values are its means,
   * held for its whole duration; a gap between one segment's end and the next one's start is a pause.
   * Null for per-second data.
   */
  durations: number[] | null;
  columns: Partial<Record<Metric, Array<number | null>>>;
  /** The `SweatStack-Attribution` response header, e.g. "Garmin". */
  attribution: string | null;
};

export type UserInfo = {
  sub: string;
  name: string;
  given_name?: string | null;
  email?: string | null;
};

export type BackfillStatus = {
  /** How far back history has been imported so far, or null when there are no activities (yet). */
  backfill_loaded_until: string | null;
};

/** Token endpoint response (POST /api/v1/oauth/token). */
export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string | null;
  scope?: string | null;
};

// --- Profile: zones and metabolic map (beta) https://docs.sweatstack.no/learn/data/metabolic-profile/ ---

export type ZoneMetric = "power" | "speed" | "heart_rate";

export type Zone = {
  /** Stable: "Z1".."Z7". Branch on this. */
  name: string;
  /** For display only, e.g. "Endurance". */
  label: string;
  /** Inclusive lower bound (W, m/s or bpm). */
  lower: number;
  /** Exclusive upper bound, or null for an open top zone. */
  upper: number | null;
};

export type ZonesResponse = { zone_system: string; zones: Zone[] };

export type MarkerValue = {
  value: number;
  /** modeled (from training), measured (a test), declared (set by a person), external (a device or other system). */
  provenance: "modeled" | "measured" | "declared" | "external";
};

/** The metabolic map for one metric: marker name → value, or null when unknown. Keys depend on the metric. */
export type MetabolicMap = Record<string, MarkerValue | null>;

/** Portal pages you can send a user to. https://docs.sweatstack.no/learn/portal/ */
export type PortalDestination = "manage-integrations" | "profile";
