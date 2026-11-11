// Push subscription endpoints, called by public/app.js (JSON in, JSON out).
//   POST /push/subscribe     store or refresh this device's subscription (called on every app open)
//   POST /push/unsubscribe   forget this device
//   POST /push/test          send a test notification to all of the user's devices

import { Hono } from "hono";
import { requireUser } from "../auth/session";
import type { AppEnv } from "../env";
import { sendToUser } from "./notify";
import { isAllowedEndpoint } from "./webpush";

export const pushRoutes = new Hono<AppEnv>();

type SubscriptionJson = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };

pushRoutes.post("/push/subscribe", requireUser, async (c) => {
  const body = await c.req.json<SubscriptionJson>().catch(() => ({}) as SubscriptionJson);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!isAllowedEndpoint(endpoint) || endpoint.length > 1024 || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth)) {
    return c.json({ error: "Invalid subscription" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(endpoint, c.var.user!.id, p256dh, auth, Date.now())
    .run();
  return c.json({ ok: true });
});

pushRoutes.post("/push/unsubscribe", requireUser, async (c) => {
  const body = await c.req.json<{ endpoint?: unknown }>().catch(() => ({}) as { endpoint?: unknown });
  if (typeof body.endpoint === "string") {
    await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(body.endpoint, c.var.user!.id).run();
  }
  return c.json({ ok: true });
});

pushRoutes.post("/push/test", requireUser, async (c) => {
  const summary = await sendToUser(c.env.DB, c.var.deps.fetch, c.var.secrets, new URL(c.req.url).origin, c.var.user!.id, {
    title: "Notifications work",
    body: "You'll get a notification like this when a new activity arrives.",
    url: "/",
    tag: "test",
  });
  return c.json(summary);
});
