// Sessions: a signed, httpOnly cookie that holds only the user's SweatStack id.
// Tokens never go to the browser; they live encrypted in D1 (see ./tokens.ts).
//
// - loadSession (middleware, every request): reads the cookie, checks the user still exists, sets c.var.user.
// - requireUser (middleware, per route): sends signed-out visitors to sign in, and back afterwards.

import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { AppEnv, SessionUser } from "../env";

const SESSION_COOKIE = "session";
const SESSION_DAYS = 30;
/** Re-issue the cookie when it is older than this, so active users stay signed in. */
const RENEW_AFTER_DAYS = 7;
const DAY = 24 * 60 * 60;
/** Write `last_seen_at` at most this often (ms), to avoid a D1 write on every request. */
const LAST_SEEN_EVERY_MS = 60 * 60 * 1000;

export function cookieOptions(c: Context<AppEnv>, maxAgeSeconds: number) {
  return {
    path: "/",
    httpOnly: true,
    // Secure on https. Plain http only happens on localhost during `wrangler dev`.
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax" as const,
    maxAge: maxAgeSeconds,
  };
}

export async function startSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const value = `${userId}|${Math.floor(Date.now() / 1000)}`;
  await setSignedCookie(c, SESSION_COOKIE, value, c.var.secrets.cookieKey, cookieOptions(c, SESSION_DAYS * DAY));
}

export function endSession(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  const cookie = await getSignedCookie(c, c.var.secrets.cookieKey, SESSION_COOKIE);
  if (cookie) {
    const [userId, issuedAt] = cookie.split("|");
    const row = userId
      ? await c.env.DB.prepare("SELECT id, name, created_at, last_seen_at FROM users WHERE id = ?")
          .bind(userId)
          .first<{ id: string; name: string | null; created_at: number; last_seen_at: number }>()
      : null;

    if (!row) {
      endSession(c); // the user disconnected, or their SweatStack connection ended
    } else {
      const user: SessionUser = {
        id: row.id,
        name: row.name,
        isAdmin: c.var.config.adminUserIds.includes(row.id),
        createdAt: row.created_at,
      };
      c.set("user", user);
      if (Date.now() / 1000 - Number(issuedAt) > RENEW_AFTER_DAYS * DAY) await startSession(c, row.id);
      if (Date.now() - row.last_seen_at > LAST_SEEN_EVERY_MS) {
        c.executionCtx.waitUntil(
          c.env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(Date.now(), row.id).run(),
        );
      }
    }
  }
  await next();
};

/** Route guard: signed-out visitors go to sign-in, then come back to this page. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.user) return next();
  if (c.req.header("HX-Request")) {
    // An htmx fragment request: tell htmx to do a full-page redirect instead of swapping in a login page.
    c.header("HX-Redirect", "/");
    return c.body(null, 401);
  }
  if (c.req.header("content-type")?.includes("application/json")) return c.json({ error: "Sign in first" }, 401);
  // A form posted after the session ended: sign in again, then land back on the page.
  if (c.req.method !== "GET") return c.redirect("/auth/login", 303);
  const url = new URL(c.req.url);
  return c.redirect(`/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
};

/** Only allow local paths as a post-login destination (no open redirects). */
export function safeNextPath(next: string | undefined | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
