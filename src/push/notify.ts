// Send a notification to every device a user subscribed. This is the function to call from your own code:
//
//   await sendToUser(c.env.DB, c.var.deps.fetch, c.var.secrets, origin, userId, {
//     title: "Weekly summary", body: "You trained 6h 40m this week", url: "/",
//   });
//
// The service worker (public/sw.js) shows it, and opens `url` when it is tapped.

import type { AppSecrets } from "../secrets";
import type { Fetch } from "../sweatstack/http";
import { sendPush, vapidSubject, type PushTarget } from "./webpush";

export type Notification = {
  title: string;
  body: string;
  /** Where tapping the notification goes, e.g. "/activities/abc". Must be a path in this app. */
  url: string;
  /** Notifications with the same tag replace each other instead of stacking. */
  tag?: string;
};

export type SendSummary = { sent: number; removed: number; failed: number };

export async function sendToUser(
  db: D1Database,
  fetchFn: Fetch,
  secrets: AppSecrets,
  origin: string,
  userId: string,
  notification: Notification,
): Promise<SendSummary> {
  const { results } = await db
    .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?")
    .bind(userId)
    .all<PushTarget>();

  const vapid = { ...secrets.vapid, subject: vapidSubject(origin) };
  const payload = JSON.stringify(notification);
  const summary: SendSummary = { sent: 0, removed: 0, failed: 0 };

  await Promise.all(
    results.map(async (target) => {
      try {
        const result = await sendPush(fetchFn, target, payload, vapid);
        if (result.ok) {
          summary.sent++;
          await db.prepare("UPDATE push_subscriptions SET last_success_at = ? WHERE endpoint = ?").bind(Date.now(), target.endpoint).run();
        } else if (result.gone) {
          // The browser unsubscribed or the subscription expired: forget it.
          summary.removed++;
          await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(target.endpoint).run();
        } else {
          summary.failed++;
          console.error(JSON.stringify({ level: "warn", message: "Push rejected", status: result.status, host: new URL(target.endpoint).host }));
        }
      } catch (error) {
        summary.failed++;
        console.error(JSON.stringify({ level: "warn", message: "Push failed", error: String(error) }));
      }
    }),
  );
  return summary;
}
