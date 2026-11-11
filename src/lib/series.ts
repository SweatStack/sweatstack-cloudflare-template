// Small data helpers for charts.

import type { ActivitySummary } from "../sweatstack/types";
import { parseDuration } from "./format";

/**
 * Downsamples a series to at most `threshold` points with Largest-Triangle-Three-Buckets, which keeps
 * the visual shape (peaks and dips) far better than taking every n-th point. Null samples are dropped.
 */
export function downsample(xs: readonly number[], ys: readonly (number | null)[], threshold: number): [number[], number[]] {
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y !== null && y !== undefined && Number.isFinite(y)) {
      px.push(xs[i]!);
      py.push(y);
    }
  }
  if (threshold >= px.length || threshold < 3) return [px, py];

  const outX = [px[0]!];
  const outY = [py[0]!];
  const bucketSize = (px.length - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    // Average of the next bucket: the third point of the triangle.
    const nextStart = Math.floor((i + 1) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, px.length);
    let avgX = 0;
    let avgY = 0;
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += px[j]!;
      avgY += py[j]!;
    }
    const count = Math.max(1, nextEnd - nextStart);
    avgX /= count;
    avgY /= count;

    // The point in this bucket that makes the largest triangle with the previous pick and the average.
    const start = Math.floor(i * bucketSize) + 1;
    const end = Math.floor((i + 1) * bucketSize) + 1;
    let maxArea = -1;
    let pick = start;
    for (let j = start; j < end; j++) {
      const area = Math.abs((px[a]! - avgX) * (py[j]! - py[a]!) - (px[a]! - px[j]!) * (avgY - py[a]!));
      if (area > maxArea) {
        maxArea = area;
        pick = j;
      }
    }
    outX.push(px[pick]!);
    outY.push(py[pick]!);
    a = pick;
  }
  outX.push(px[px.length - 1]!);
  outY.push(py[py.length - 1]!);
  return [outX, outY];
}

export type WeekTotal = { weekStart: Date; seconds: number; count: number };

/** Monday 00:00 (UTC-based calendar date) of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7; // Monday = 0
  day.setUTCDate(day.getUTCDate() - offset);
  return day;
}

/**
 * Training time per week for the last `weeks` weeks (oldest first, current week last), grouped by
 * each activity's local calendar date.
 */
export function weeklyTotals(activities: readonly ActivitySummary[], weeks: number, today = new Date()): WeekTotal[] {
  const current = startOfWeek(today);
  const totals: WeekTotal[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = new Date(current);
    weekStart.setUTCDate(current.getUTCDate() - i * 7);
    totals.push({ weekStart, seconds: 0, count: 0 });
  }
  const first = totals[0]!.weekStart.getTime();
  for (const activity of activities) {
    const local = new Date(`${activity.start_local.slice(0, 10)}T00:00:00Z`);
    const index = Math.floor((startOfWeek(local).getTime() - first) / (7 * 86400_000));
    const bucket = totals[index];
    if (!bucket) continue;
    bucket.seconds += parseDuration(activity.duration) ?? 0;
    bucket.count += 1;
  }
  return totals;
}

/** First day of the trend window, as YYYY-MM-DD (for the activities `start` filter). */
export function trendStartDate(weeks: number, today = new Date()): string {
  const start = startOfWeek(today);
  start.setUTCDate(start.getUTCDate() - (weeks - 1) * 7);
  return start.toISOString().slice(0, 10);
}
