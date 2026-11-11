import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { form, json, testApp } from "./helpers";

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM users"), env.DB.prepare("DELETE FROM app_state")]);
});

describe("before setup", () => {
  it("sends every page to /setup while credentials are missing, and /setup shows this deployment's values", async () => {
    const { request } = testApp({ env: { SWEATSTACK_CLIENT_ID: "", SWEATSTACK_CLIENT_SECRET: "" } });
    for (const path of ["/", "/activities", "/settings", "/admin", "/auth/login", "/nope"]) {
      const response = await request(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe("/setup");
    }
    const setup = await request("https://my-app.example.workers.dev/setup");
    expect(setup.status).toBe(200);
    const html = await setup.text();
    expect(html).toContain("https://my-app.example.workers.dev/");
    expect(html).toContain("https://my-app.example.workers.dev/privacy");
    expect(html).toContain("SWEATSTACK_CLIENT_SECRET");

    for (const path of ["/privacy", "/terms", "/healthz"]) expect((await request(path)).status, path).toBe(200);
  });

  it("makes htmx fragment requests navigate to /setup instead of swapping it in", async () => {
    const { request } = testApp({ env: { SWEATSTACK_CLIENT_ID: "" } });
    const response = await request("/activities/x/chart?metrics=power", { headers: { "HX-Request": "true" } });
    expect(response.headers.get("HX-Redirect")).toBe("/setup");
  });

  it("treats a missing secret alone as incomplete", async () => {
    const { request } = testApp({ env: { SWEATSTACK_CLIENT_SECRET: "  " } });
    expect((await request("/")).headers.get("location")).toBe("/setup");
  });

  it("redirects /setup away once configured", async () => {
    const { request } = testApp();
    expect((await request("/setup")).headers.get("location")).toBe("/");
  });
});

describe("signed out", () => {
  it("shows the landing page with Sign in with SweatStack and the Finish setup panel until the first sign-in", async () => {
    const { request, signIn } = testApp();
    const before = await (await request("/")).text();
    expect(before).toContain("Sign in with SweatStack");
    expect(before).toContain("/brand/sweatstack-mark.svg");
    expect(before).toContain("Finish setup");

    await signIn();
    await request("/auth/logout", form({}));
    expect(await (await request("/")).text()).not.toContain("Finish setup");
  });

  it("sends protected pages to sign-in and back", async () => {
    const { request } = testApp();
    const response = await request("/activities/demo-00");
    expect(response.headers.get("location")).toBe("/auth/login?next=%2Factivities%2Fdemo-00");
  });

  it("tells htmx to do a full redirect instead of swapping in a login page", async () => {
    const { request } = testApp();
    const response = await request("/partials/last-activity", { headers: { "HX-Request": "true" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("HX-Redirect")).toBe("/");
  });
});

describe("signed in", () => {
  it("renders the dashboard with the last activity, the trend chart and attribution", async () => {
    const { request, signIn } = testApp();
    await signIn();
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).toContain("Last activity");
    expect(html).toContain('hx-get="/partials/last-activity"');
    expect(html).toContain('<training-chart type="bars"');
    expect(html).toContain("Data from Garmin");
  });

  it("refreshes the last-activity fragment without the layout", async () => {
    const { request, signIn } = testApp();
    await signIn();
    const html = await (await request("/partials/last-activity", { headers: { "HX-Request": "true" } })).text();
    expect(html).toMatch(/^<div id="last-activity"/);
    expect(html).not.toContain("<html");
  });

  it("paginates activities with query params, keeping the sport filter", async () => {
    const { request, signIn, sweatstack } = testApp();
    await signIn();
    const page1 = await (await request("/activities?sport=running")).text();
    expect(page1).toContain('href="/activities?sport=running&amp;page=2"');
    expect(page1).not.toContain('rel="prev"');

    const call = sweatstack.calls.findLast((c) => c.url.includes("/api/v1/activities/?"))!;
    const params = new URL(call.url).searchParams;
    expect(params.get("limit")).toBe("21");
    expect(params.get("offset")).toBe("0");
    expect(params.get("sport")).toBe("running");

    const page2 = await (await request("/activities?sport=running&page=2")).text();
    expect(page2).toContain('rel="prev"');
    expect(new URL(sweatstack.calls.findLast((c) => c.url.includes("/api/v1/activities/?"))!.url).searchParams.get("offset")).toBe("20");

    const beyond = await (await request("/activities?page=99")).text();
    expect(beyond).toContain("No more activities");
    expect((await request("/activities?page=-4&sport=<script>")).status).toBe(200);
  });

  it("renders an activity with stats and laps, and its chart as a lazy fragment", async () => {
    const { request, signIn, sweatstack } = testApp();
    await signIn();
    const response = await request("/activities/demo-00");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Avg heart rate");
    expect(html).toContain("Laps");
    expect(html).toContain('hx-get="/activities/demo-00/chart?metrics=heart_rate,power,speed"');
    expect(sweatstack.calls.some((c) => c.url.includes("/data?"))).toBe(false); // the page itself never waits for Parquet

    const chart = await (await request("/activities/demo-00/chart?metrics=heart_rate,power,speed", { headers: { "HX-Request": "true" } })).text();
    expect(chart).toContain('<training-chart type="line"');
    expect(chart).toContain("Heart rate: average");
    expect(chart).toContain("Data from Garmin");
    expect(chart).not.toContain("<html");
    const params = new URL(sweatstack.calls.find((c) => c.url.includes("/data?"))!.url).searchParams;
    expect(params.getAll("metrics")).toEqual(["heart_rate", "power", "speed"]);
    expect(params.get("segmentation_on")).toBe("power"); // AISC: small payloads, cheap to decode

    const unknown = await (await request("/activities/demo-00/chart?metrics=evil,<script>")).text();
    expect(unknown).toBe("");
  });

  it("renders pages in the theme chosen with the toggle", async () => {
    const { request, cookies } = testApp();
    expect(await (await request("/privacy")).text()).toMatch(/^<html lang="en">/);
    cookies.set("theme", "dark");
    expect(await (await request("/privacy")).text()).toMatch(/^<html lang="en" data-theme="dark">/);
    cookies.set("theme", "<script>");
    expect(await (await request("/privacy")).text()).toMatch(/^<html lang="en">/);
  });

  it("shows a friendly 404 for an unknown activity", async () => {
    const { request, signIn } = testApp();
    await signIn();
    const response = await request("/activities/does-not-exist");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no such item");
  });

  it("opens the SweatStack Portal, with a return link unless running as an installed app", async () => {
    const { request, signIn, sweatstack } = testApp();
    await signIn();
    const browser = await request("/settings/data-sources", form({ standalone: "0" }));
    expect(browser.status).toBe(303);
    expect(browser.headers.get("location")).toContain("https://app.sweatstack.no/portal/");
    const body = JSON.parse(sweatstack.calls.findLast((c) => c.url.endsWith("/portal/sessions"))!.body);
    expect(body).toEqual({ destination: "manage-integrations", return_url: "http://localhost/settings" });

    await request("/settings/data-sources", form({ standalone: "1" }));
    expect(JSON.parse(sweatstack.calls.findLast((c) => c.url.endsWith("/portal/sessions"))!.body)).toEqual({ destination: "manage-integrations" });
  });

  it("stores push subscriptions only for known push services", async () => {
    const { request, signIn } = testApp();
    await signIn();
    const keys = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
    expect((await request("/push/subscribe", json({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys }))).status).toBe(200);
    expect((await request("/push/subscribe", json({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys }))).status).toBe(200); // idempotent
    expect((await request("/push/subscribe", json({ endpoint: "https://evil.example/x", keys }))).status).toBe(400);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>())!;
    expect(n).toBe(1);

    const test = await request("/push/test", json({}));
    expect(await test.json()).toEqual({ sent: 1, removed: 0, failed: 0 });
  });

  it("disconnect deletes everything the app stores about the user", async () => {
    const { request, signIn } = testApp();
    await signIn();
    const response = await request("/settings/disconnect", form({}));
    expect(response.headers.get("location")).toBe("/?disconnected=1");
    expect(await env.DB.prepare("SELECT id FROM users").first()).toBeNull();
    expect((await request("/settings")).status).toBe(302);
  });
});

describe("admin", () => {
  it("is only for ADMIN_USER_IDS", async () => {
    const { request, signIn } = testApp();
    await signIn(); // signs in as demo-athlete, who is not an admin in the test config
    const response = await request("/admin");
    expect(response.status).toBe(404);
  });

  it("shows the setup checklist to admins", async () => {
    const { request, signIn } = testApp({ env: { ADMIN_USER_IDS: "someone-else, demo-athlete" } });
    await signIn();
    const html = await (await request("/admin")).text();
    expect(html).toContain("Redirect URI registered");
    expect(html).toContain("Privacy policy and terms");
    expect(html).toContain("http://localhost/webhooks/sweatstack");
  });

  it("shows a signed-in user their own id while no admins are configured", async () => {
    const { request, signIn } = testApp({ env: { ADMIN_USER_IDS: "" } });
    await signIn();
    const html = await (await request("/admin")).text();
    expect(html).toContain("Become an admin");
    expect(html).toContain('value="demo-athlete"');
  });
});

describe("design workbench", () => {
  it("is open on localhost and renders every page from demo data", async () => {
    const { request } = testApp();
    expect((await request("/design")).status).toBe(200);
    for (const page of ["landing", "dashboard", "activities", "activity", "settings", "admin", "setup", "privacy"]) {
      expect((await request(`/design/pages/${page}`)).status, page).toBe(200);
    }
  });

  it("serves a demo page's htmx fragments from demo data too", async () => {
    const { request } = testApp();
    const page = await (await request("/design/pages/activity")).text();
    const fragment = /hx-get="(\/design\/fragment\/activities\/[^"]+)"/.exec(page)?.[1];
    expect(fragment).toBeDefined();
    const chart = await (await request(fragment!.replaceAll("&amp;", "&"), { headers: { "HX-Request": "true" } })).text();
    expect(chart).toContain('<training-chart type="line"');
  });

  it("is hidden on a deployed app for anyone but admins", async () => {
    const { request } = testApp();
    expect((await request("https://my-app.example.workers.dev/design")).status).toBe(404);
    expect((await request("https://my-app.example.workers.dev/design/pages/dashboard")).status).toBe(404);
  });
});

describe("legal pages", () => {
  it("render the Markdown placeholders with a warning", async () => {
    const { request } = testApp();
    const html = await (await request("/privacy")).text();
    expect(html).toContain("<h1>Privacy policy</h1>");
    expect(html).toContain("Placeholder");
    expect(html).toContain("Training Log is run by");
  });
});
