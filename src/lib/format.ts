// Formatting for display. All units are metric; to support imperial, change this file only.

import type { ActivitySummary } from "../sweatstack/types";

/** Seconds in an ISO 8601 duration such as "PT1H32M10S" or "P1DT2H". Returns null if unparseable. */
export function parseDuration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!match) return null;
  const [, d, h, m, s] = match.map((part) => (part === undefined ? 0 : Number(part)));
  return (d ?? 0) * 86400 + (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

/** "1:32:10" or "33:27". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "6h 40m", "45m". For totals and chart labels. */
export function formatHours(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "42.1 km", "850 m". */
export function formatDistance(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || !Number.isFinite(meters) || meters <= 0) return null;
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 100_000 ? 1 : 0)} km`;
}

/** Speed as pace for running and walking ("4:52 /km"), as km/h otherwise ("28.4 km/h"). */
export function formatSpeed(metersPerSecond: number | null | undefined, sport: string): string | null {
  if (!metersPerSecond || !Number.isFinite(metersPerSecond) || metersPerSecond <= 0) return null;
  if (usesPace(sport)) return `${formatDuration(1000 / metersPerSecond)} /km`;
  return `${(metersPerSecond * 3.6).toFixed(1)} km/h`;
}

export function usesPace(sport: string): boolean {
  const root = sportRoot(sport);
  return root === "running" || root === "walking";
}

export function formatNumber(value: number | null | undefined, unit: string): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${Math.round(value)} ${unit}`;
}

// --- Sports ----------------------------------------------------------------------------------
// SweatStack sports use the OpenSportTaxonomy: "cycling", "cycling.road", "rowing+stationary".
// Dots add a sub-sport, "+" adds modifiers.

export function sportRoot(sport: string): string {
  return sport.split(/[.+]/)[0] ?? sport;
}

/** "cycling.road+stationary" → "Cycling (road, stationary)". */
export function formatSport(sport: string): string {
  const [path = sport, ...modifiers] = sport.split("+");
  const [root = path, ...subs] = path.split(".");
  const details = [...subs, ...modifiers].map((part) => part.replace(/_/g, " "));
  const name = capitalize(root.replace(/_/g, " "));
  return details.length ? `${name} (${details.join(", ")})` : name;
}

const SPORT_NOUNS: Record<string, string> = {
  running: "run",
  cycling: "ride",
  swimming: "swim",
  walking: "walk",
  rowing: "row",
  hiking: "hike",
  skiing: "ski",
  cross_country_skiing: "ski",
};

/**
 * A human title for an activity, since SweatStack activities have no name: "Morning ride".
 * Uses the activity's local time of day.
 */
export function activityTitle(activity: Pick<ActivitySummary, "sport" | "start_local">): string {
  const root = sportRoot(activity.sport);
  const noun = SPORT_NOUNS[root] ?? `${root.replace(/_/g, " ")} session`;
  const hour = Number(activity.start_local.slice(11, 13));
  const part = hour < 5 ? "Night" : hour < 12 ? "Morning" : hour < 14 ? "Lunch" : hour < 18 ? "Afternoon" : hour < 22 ? "Evening" : "Night";
  return `${part} ${noun}`;
}

// --- Dates -------------------------------------------------------------------------------------
// `start_local` is the athlete's wall-clock time without an offset ("2026-11-10T19:53:58").
// Format it as-is (pretending it is UTC), never converted to the server's or viewer's timezone.

const dateFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dateYearFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function localDate(local: string): Date {
  return new Date(`${local.slice(0, 19)}Z`);
}

/** "Tue 10 Nov", or "Tue 10 Nov 2025" when not in `currentYear`. */
export function formatDate(local: string, currentYear = new Date().getUTCFullYear()): string {
  const date = localDate(local);
  return (date.getUTCFullYear() === currentYear ? dateFormat : dateYearFormat).format(date);
}

/** "19:53". */
export function formatTime(local: string): string {
  return timeFormat.format(localDate(local));
}

/** "10 Nov". */
export function formatDayMonth(date: Date): string {
  return monthFormat.format(date);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, (now - ms) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
