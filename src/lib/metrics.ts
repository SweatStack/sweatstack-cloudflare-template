// How each metric is shown: label, unit and chart colour. One place, so every page agrees.

import type { Metric } from "../sweatstack/types";
import { formatDuration, usesPace } from "./format";

export type MetricDisplay = {
  label: string;
  unit: string;
  /** A colour token from public/app.css (without the "--"). */
  color: "hr" | "power" | "speed" | "accent";
};

/** Metrics the activity page charts, in this order (when the activity has them). */
export const CHART_METRICS = [
  "power",
  "heart_rate",
  "speed",
  "cadence",
  "altitude",
  "temperature",
  "core_temperature",
  "smo2",
  "respiration_rate",
] as const satisfies readonly Metric[];

const DISPLAY: Record<(typeof CHART_METRICS)[number], MetricDisplay> = {
  power: { label: "Power", unit: "W", color: "power" },
  heart_rate: { label: "Heart rate", unit: "bpm", color: "hr" },
  speed: { label: "Speed", unit: "km/h", color: "speed" },
  cadence: { label: "Cadence", unit: "rpm", color: "accent" },
  altitude: { label: "Altitude", unit: "m", color: "accent" },
  temperature: { label: "Temperature", unit: "°C", color: "accent" },
  core_temperature: { label: "Core temperature", unit: "°C", color: "accent" },
  smo2: { label: "Muscle oxygen", unit: "%", color: "accent" },
  respiration_rate: { label: "Respiration", unit: "/min", color: "accent" },
};

/**
 * Display settings for a metric in a sport. Speed is shown as pace (min/km) for running and walking,
 * with `pace: true` so charts can format the axis and put faster at the top.
 */
export function metricDisplay(metric: (typeof CHART_METRICS)[number], sport: string): MetricDisplay & { pace?: boolean } {
  if (metric === "speed" && usesPace(sport)) return { label: "Pace", unit: "/km", color: "speed", pace: true };
  if (metric === "cadence" && usesPace(sport)) return { ...DISPLAY.cadence, unit: "spm" };
  return DISPLAY[metric];
}

/** A metric's raw value converted for display: m/s → km/h, or → seconds per km for pace. */
export function toDisplayValue(metric: string, value: number | null, pace = false): number | null {
  if (value === null) return null;
  if (metric !== "speed") return value;
  if (pace) return value > 0.5 ? 1000 / value : null; // slower than 33 min/km is standing still
  return value * 3.6;
}

/** "4:52 /km", "212 W", "31.5 km/h". */
export function formatMetricValue(value: number, display: MetricDisplay & { pace?: boolean }): string {
  if (display.pace) return `${formatDuration(value)} /km`;
  return `${Math.abs(value) < 10 && display.unit !== "W" ? value.toFixed(1) : Math.round(value)} ${display.unit}`;
}
