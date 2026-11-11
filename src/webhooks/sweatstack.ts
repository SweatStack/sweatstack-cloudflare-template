// POST /webhooks/sweatstack: SweatStack tells us when a user's data changes.
// Guide: https://docs.sweatstack.no/learn/advanced/webhooks/
//
//   1. Verify the Standard Webhooks signature (and reject old timestamps, against replays).
//   2. Record the event id. SweatStack retries deliveries, so an id we already have is a duplicate: ack and stop.
//   3. Answer 200 right away (SweatStack waits at most 2 seconds), and do the work afterwards in waitUntil().
//
// To react to another event type, add a case to handleEvent() below.

import { Hono } from "hono";
import { TokenStore } from "../auth/tokens";
import type { AppEnv } from "../env";
import { activityTitle, formatDistance, formatDuration, parseDuration, formatSport } from "../lib/format";
import { base64Decode, base64Encode, hmacSha256, timingSafeEqual, utf8 } from "../lib/crypto";
import { sendToUser } from "../push/notify";
import type { AppSecrets } from "../secrets";
import { setAppState } from "../state";
import { SweatStackClient } from "../sweatstack/client";
import { NotAuthenticatedError, SweatStackError, type Fetch } from "../sweatstack/http";
import type { Config } from "../config";

export const webhookRoutes = new Hono<AppEnv>();

const MAX_CLOCK_SKEW_S = 5 * 60;
const KEEP_EVENTS_MS = 14 * 24 * 3600 * 1000;

export type WebhookEvent = {
  id?: string;
  user_id: string;
  event_type: string;
  resource_id: string | null;
  timestamp: string;
};

webhookRoutes.post("/webhooks/sweatstack", async (c) => {
  const { webhookSecret, missing } = c.var.config;
  // 503 makes SweatStack retry later (for about 12 hours), so no events are lost while you finish setup.
  if (!webhookSecret || missing.length > 0) return c.text("Webhooks are not configured on this app yet", 503);

  const body = await c.req.text();
  const id = c.req.header("webhook-id") ?? "";
  const verified = await verifyWebhook(webhookSecret, {
    id,
    timestamp: c.req.header("webhook-timestamp") ?? "",
    signature: c.req.header("webhook-signature") ?? "",
    body,
  });
  if (!verified.ok) {
    await setAppState(c.env.DB, "last_webhook_error", verified.reason);
    return c.text("Invalid signature", 401);
  }

  let event: WebhookEvent;
  try {
    event = JSON.parse(body) as WebhookEvent;
  } catch {
    return c.text("Invalid JSON", 400);
  }

  const inserted = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_events (id, event_type, user_id, resource_id, status, received_at)
     VALUES (?, ?, ?, ?, 'received', ?)`,
  )
    .bind(id, event.event_type, event.user_id ?? null, event.resource_id ?? null, Date.now())
    .run();
  if (inserted.meta.changes === 0) return c.json({ ok: true, duplicate: true });

  const db = c.env.DB;
  const work = async () => {
    await setAppState(db, "last_webhook_at", new Date().toISOString());
    await db.prepare("DELETE FROM webhook_events WHERE received_at < ?").bind(Date.now() - KEEP_EVENTS_MS).run();
    const { status, detail } = await handleEvent(event, {
      db,
      fetchFn: c.var.deps.fetch,
      secrets: c.var.secrets,
      config: c.var.config,
      origin: new URL(c.req.url).origin,
    });
    await db.prepare("UPDATE webhook_events SET status = ?, detail = ? WHERE id = ?").bind(status, detail, id).run();
  };
  c.executionCtx.waitUntil(
    work().catch((error) => console.error(JSON.stringify({ level: "error", message: "Webhook handling failed", eventId: id, error: String(error) }))),
  );
  return c.json({ ok: true });
});

type HandlerContext = { db: D1Database; fetchFn: Fetch; secrets: AppSecrets; config: Config; origin: string };
type Outcome = { status: "notified" | "skipped" | "failed"; detail: string };

export async function handleEvent(event: WebhookEvent, ctx: HandlerContext): Promise<Outcome> {
  switch (event.event_type) {
    case "activity_created":
      return notifyNewActivity(event, ctx);
    // Add more cases here, e.g. "activity_updated", "test_created". Event types:
    // https://docs.sweatstack.no/learn/advanced/webhooks/#event-types
    default:
      return { status: "skipped", detail: "event type not handled" };
  }
}

async function notifyNewActivity(event: WebhookEvent, ctx: HandlerContext): Promise<Outcome> {
  if (!event.resource_id) return { status: "skipped", detail: "no activity id" };

  const subscriptions = await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?")
    .bind(event.user_id)
    .first<{ n: number }>();
  if (!subscriptions?.n) return { status: "skipped", detail: "user has no push subscriptions" };

  const tokens = new TokenStore(ctx.db, ctx.secrets.tokenKey, ctx.config, ctx.fetchFn);
  const sweatstack = new SweatStackClient(ctx.fetchFn, (options) => tokens.getAccessToken(event.user_id, options));

  try {
    const activity = await sweatstack.getActivity(event.resource_id);
    const parts = [
      formatDistance(activity.summary?.distance?.sum),
      formatDuration(parseDuration(activity.duration)),
      formatSport(activity.sport),
    ].filter(Boolean);
    const summary = await sendToUser(ctx.db, ctx.fetchFn, ctx.secrets, ctx.origin, event.user_id, {
      title: activityTitle(activity),
      body: parts.join(" · "),
      url: `/activities/${encodeURIComponent(activity.id)}`,
      tag: `activity-${activity.id}`,
    });
    const detail = `sent ${summary.sent}, removed ${summary.removed}, failed ${summary.failed}`;
    return { status: summary.sent > 0 ? "notified" : "failed", detail };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "skipped", detail: "user is no longer connected" };
    // Deleted before we got to it: not an error.
    if (error instanceof SweatStackError && error.isNotFound) return { status: "skipped", detail: "activity no longer exists" };
    return { status: "failed", detail: error instanceof Error ? error.message.slice(0, 200) : "unknown error" };
  }
}

/**
 * Verifies a Standard Webhooks signature (https://www.standardwebhooks.com/):
 * HMAC-SHA256 over "{id}.{timestamp}.{body}" with the base64-decoded part of the `whsec_` secret.
 */
export async function verifyWebhook(
  secret: string,
  { id, timestamp, signature, body }: { id: string; timestamp: string; signature: string; body: string },
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing webhook-id, webhook-timestamp or webhook-signature header" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_CLOCK_SKEW_S) return { ok: false, reason: "timestamp too old or in the future" };

  let key: Uint8Array<ArrayBuffer>;
  try {
    key = base64Decode(secret.replace(/^whsec_/, ""));
  } catch {
    return { ok: false, reason: "SWEATSTACK_WEBHOOK_SECRET is not a valid whsec_ secret" };
  }
  const expected = base64Encode(await hmacSha256(key, utf8(`${id}.${timestamp}.${body}`)));
  const matches = signature
    .split(" ")
    .map((part) => part.split(","))
    .some(([version, value]) => version === "v1" && value !== undefined && timingSafeEqual(value, expected));
  return matches ? { ok: true } : { ok: false, reason: "signature mismatch (is SWEATSTACK_WEBHOOK_SECRET the current secret?)" };
}
