import { describe, expect, it } from "vitest";
import { base64urlDecode, base64urlEncode, decryptString, encryptString, importAesKey, randomToken, timingSafeEqual } from "../src/lib/crypto";
import { activityTitle, formatDistance, formatDuration, formatHours, formatSpeed, formatSport, parseDuration } from "../src/lib/format";
import { downsample, startOfWeek, steppedSeries, timeInZones, weeklyTotals } from "../src/lib/series";
import { demoActivities } from "../src/fixtures";
import { parsePage, parseSport } from "../src/pages/activities";
import { safeNextPath } from "../src/auth/session";

describe("crypto", () => {
  it("round-trips AES-GCM and rejects tampering", async () => {
    const key = await importAesKey(randomToken(32));
    const sealed = await encryptString(key, "refresh-token-123");
    expect(sealed).not.toContain("refresh-token-123");
    expect(await decryptString(key, sealed)).toBe("refresh-token-123");

    const [v, iv, ct] = sealed.split(".");
    const flipped = ct!.slice(0, -2) + (ct!.slice(-2) === "AA" ? "AB" : "AA");
    await expect(decryptString(key, `${v}.${iv}.${flipped}`)).rejects.toThrow();
    await expect(decryptString(await importAesKey(randomToken(32)), sealed)).rejects.toThrow();
  });

  it("base64url round-trips and compares in constant time", () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 128]);
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes);
    expect(base64urlEncode(bytes)).not.toMatch(/[+/=]/);
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("format", () => {
  it("parses ISO 8601 durations as SweatStack sends them", () => {
    expect(parseDuration("PT33M27S")).toBe(2007);
    expect(parseDuration("PT1H32M10S")).toBe(5530);
    expect(parseDuration("PT38S")).toBe(38);
    expect(parseDuration("P1DT2H")).toBe(93600);
    expect(parseDuration("garbage")).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });

  it("formats durations, distances and speeds", () => {
    expect(formatDuration(2007)).toBe("33:27");
    expect(formatDuration(5530)).toBe("1:32:10");
    expect(formatDuration(null)).toBe("–");
    expect(formatHours(24000)).toBe("6h 40m");
    expect(formatDistance(6027)).toBe("6.0 km");
    expect(formatDistance(850)).toBe("850 m");
    expect(formatDistance(null)).toBeNull();
    expect(formatSpeed(1000 / 292, "running")).toBe("4:52 /km");
    expect(formatSpeed(8.75, "cycling.road")).toBe("31.5 km/h");
  });

  it("names sports and activities", () => {
    expect(formatSport("cycling.road+stationary")).toBe("Cycling (road, stationary)");
    expect(formatSport("rowing+stationary")).toBe("Rowing (stationary)");
    expect(formatSport("running")).toBe("Running");
    expect(activityTitle({ sport: "cycling.road", start_local: "2026-11-10T07:12:00" })).toBe("Morning ride");
    expect(activityTitle({ sport: "rowing+stationary", start_local: "2026-11-10T19:53:58" })).toBe("Evening row");
    expect(activityTitle({ sport: "yoga", start_local: "2026-11-10T12:30:00" })).toBe("Lunch yoga session");
  });
});

describe("series", () => {
  it("downsamples while keeping endpoints and the peak", () => {
    const xs = Array.from({ length: 5000 }, (_, i) => i);
    const ys = xs.map((x) => (x === 2500 ? 500 : Math.sin(x / 100) * 50 + 100));
    const [dx, dy] = downsample(xs, ys, 300);
    expect(dx).toHaveLength(300);
    expect(dx[0]).toBe(0);
    expect(dx.at(-1)).toBe(4999);
    expect(Math.max(...dy)).toBe(500);
  });

  it("drops null samples", () => {
    expect(downsample([0, 1, 2], [1, null, 3], 10)).toEqual([[0, 2], [1, 3]]);
  });

  it("totals training time per week, current week last", () => {
    const today = new Date("2026-11-11T12:00:00Z"); // a Wednesday
    expect(startOfWeek(today).toISOString()).toBe("2026-11-09T00:00:00.000Z");
    const weeks = weeklyTotals(demoActivities(today), 12, today);
    expect(weeks).toHaveLength(12);
    expect(weeks.at(-1)!.weekStart.toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(weeks.at(-1)!.count).toBe(2); // Tuesday run + Wednesday ride
    expect(weeks[0]!.seconds).toBeGreaterThan(5 * 3600);
  });
});

describe("AISC segments", () => {
  it("draws segments as steps, closes the last one, and breaks the line at pauses", () => {
    // Three segments: 0-60 s at 200 W, 60-90 s at 300 W, a pause, then 150-210 s at 180 W.
    expect(steppedSeries([0, 60, 150], [60, 30, 60], [200, 300, 180])).toEqual({
      x: [0, 60, 90, 150, 210],
      values: [200, 300, null, 180, 180],
    });
  });

  it("sums segment durations per zone, with open top zones and time above the zones", () => {
    const zones = [
      { lower: 0, upper: 150 },
      { lower: 150, upper: 250 },
      { lower: 250, upper: 330 },
    ];
    const result = timeInZones([100, 149.9, 150, 260, 400, null], [60, 30, 120, 90, 10, 500], zones);
    expect(result).toEqual({ seconds: [90, 120, 90], above: 10, total: 310 });
    expect(timeInZones([999], [5], [{ lower: 0, upper: null }]).seconds).toEqual([5]);
  });
});

describe("input parsing", () => {
  it("clamps pages and validates sports", () => {
    expect(parsePage("3")).toBe(3);
    for (const bad of [undefined, "0", "-1", "2.5", "abc", "100000"]) expect(parsePage(bad)).toBe(1);
    expect(parseSport("cycling.road")).toBe("cycling.road");
    expect(parseSport("rowing+stationary")).toBe("rowing+stationary");
    for (const bad of [undefined, "", "Cycling", "x'; drop", "../etc"]) expect(parseSport(bad)).toBeNull();
  });

  it("only allows local post-login redirects", () => {
    expect(safeNextPath("/activities?page=2")).toBe("/activities?page=2");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", undefined, ""]) expect(safeNextPath(bad)).toBe("/");
  });
});
