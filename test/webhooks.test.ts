import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { base64Decode, base64Encode, hmacSha256, utf8 } from "../src/lib/crypto";
import { verifyWebhook } from "../src/webhooks/sweatstack";
import { testApp } from "./helpers";

const SECRET = env.SWEATSTACK_WEBHOOK_SECRET;

async function signedDelivery(event: Record<string, unknown>, { id = crypto.randomUUID(), timestamp = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const body = JSON.stringify({ id, timestamp: new Date().toISOString(), ...event });
  const signature = base64Encode(await hmacSha256(base64Decode(secret.replace("whsec_", "")), utf8(`${id}.${timestamp}.${body}`)));
  return {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${signature}`,
      // No Origin header: webhooks come from SweatStack's servers, not a browser.
    },
  };
}

const subscribe = (userId: string) =>
  env.DB.prepare("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 0)")
    .bind(
      `https://fcm.googleapis.com/fcm/send/${userId}`,
      userId,
      // A real P-256 public key and auth secret are needed to encrypt: take them from the RFC 8291 vector.
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
    )
    .run();

describe("webhook signature verification", () => {
  it("accepts a valid Standard Webhooks signature and rejects the rest", async () => {
    const delivery = await signedDelivery({ event_type: "activity_created" });
    const parts = {
      id: delivery.headers["webhook-id"],
      timestamp: delivery.headers["webhook-timestamp"],
      signature: delivery.headers["webhook-signature"],
      body: delivery.body,
    };
    expect(await verifyWebhook(SECRET, parts)).toEqual({ ok: true });
    expect((await verifyWebhook(SECRET, { ...parts, body: parts.body.replace("created", "deleted") })).ok).toBe(false);
    expect((await verifyWebhook(SECRET, { ...parts, signature: `v1,${"A".repeat(44)} ${parts.signature}` })).ok).toBe(true); // several signatures
    expect((await verifyWebhook("whsec_" + btoa("another-key"), parts)).ok).toBe(false);
    expect((await verifyWebhook(SECRET, parts, Date.now() + 10 * 60_000)).ok).toBe(false); // replayed later
  });
});

describe("POST /webhooks/sweatstack", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM users"), env.DB.prepare("DELETE FROM webhook_events")]);
  });

  it("notifies the user's devices about a new activity, once per event", async () => {
    const { request, signIn, sweatstack } = testApp();
    await signIn();
    await subscribe("demo-athlete");

    const delivery = await signedDelivery({ user_id: "demo-athlete", event_type: "activity_created", resource_id: "demo-00" });
    const first = await request("/webhooks/sweatstack", delivery);
    expect(first.status).toBe(200);

    const pushes = sweatstack.calls.filter((c) => c.url.startsWith("https://fcm.googleapis.com/"));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(pushes[0]!.headers.get("authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

    const event = await env.DB.prepare("SELECT status, detail FROM webhook_events").first<{ status: string; detail: string }>();
    expect(event).toEqual({ status: "notified", detail: "sent 1, removed 0, failed 0" });

    // SweatStack retries with the same id: acknowledged, but nothing is sent again.
    const retry = await request("/webhooks/sweatstack", delivery);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, duplicate: true });
    expect(sweatstack.calls.filter((c) => c.url.startsWith("https://fcm.googleapis.com/"))).toHaveLength(1);
  });

  it("removes subscriptions the push service says are gone", async () => {
    const { request, signIn } = testApp({ pushStatus: 410 });
    await signIn();
    await subscribe("demo-athlete");
    await request("/webhooks/sweatstack", await signedDelivery({ user_id: "demo-athlete", event_type: "activity_created", resource_id: "demo-00" }));
    expect(await env.DB.prepare("SELECT endpoint FROM push_subscriptions").first()).toBeNull();
  });

  it("skips users without devices, deleted activities and other event types", async () => {
    const { request, signIn } = testApp();
    await signIn();
    await request("/webhooks/sweatstack", await signedDelivery({ user_id: "demo-athlete", event_type: "activity_created", resource_id: "demo-00" }, { id: "no-devices" }));
    await subscribe("demo-athlete");
    await request("/webhooks/sweatstack", await signedDelivery({ user_id: "demo-athlete", event_type: "activity_created", resource_id: "gone" }, { id: "deleted" }));
    await request("/webhooks/sweatstack", await signedDelivery({ user_id: "demo-athlete", event_type: "test_created", resource_id: "t1" }, { id: "other" }));

    const { results } = await env.DB.prepare("SELECT id, status, detail FROM webhook_events ORDER BY id").all();
    expect(results).toEqual([
      { id: "deleted", status: "skipped", detail: "activity no longer exists" },
      { id: "no-devices", status: "skipped", detail: "user has no push subscriptions" },
      { id: "other", status: "skipped", detail: "event type not handled" },
    ]);
  });

  it("rejects bad signatures with 401 and records why for /admin", async () => {
    const { request } = testApp();
    const response = await request("/webhooks/sweatstack", await signedDelivery({ event_type: "activity_created" }, { secret: "whsec_" + btoa("wrong-secret-wrong-secret") }));
    expect(response.status).toBe(401);
    const state = await env.DB.prepare("SELECT value FROM app_state WHERE name = 'last_webhook_error'").first<{ value: string }>();
    expect(state?.value).toContain("signature mismatch");
  });

  it("answers 503 (SweatStack retries later) while webhooks aren't configured", async () => {
    const { request } = testApp({ env: { SWEATSTACK_WEBHOOK_SECRET: "" } });
    const response = await request("/webhooks/sweatstack", await signedDelivery({ event_type: "activity_created" }));
    expect(response.status).toBe(503);
  });
});
