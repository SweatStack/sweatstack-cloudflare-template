// Sign in with SweatStack: /auth/login → SweatStack → /auth/callback → session cookie.
// Guide: https://docs.sweatstack.no/learn/authentication/oauth2/

import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { randomToken, timingSafeEqual } from "../lib/crypto";
import { setAppState } from "../state";
import { SweatStackClient } from "../sweatstack/client";
import { SweatStackError } from "../sweatstack/http";
import { authorizeUrl, exchangeCode } from "../sweatstack/oauth";
import { renderLoginError } from "../pages/errors";
import { cookieOptions, endSession, safeNextPath, startSession } from "./session";

const STATE_COOKIE = "oauth_state";
const STATE_MINUTES = 10;

export const authRoutes = new Hono<AppEnv>();

/** The one redirect URI this app uses. Register the origin (https://your-app.example/) in SweatStack. */
export function redirectUri(c: Context<AppEnv>): string {
  return `${new URL(c.req.url).origin}/auth/callback`;
}

authRoutes.get("/auth/login", async (c) => {
  // `state` protects against login CSRF: we only accept a callback that carries the value we set here.
  const state = randomToken(24);
  const next = safeNextPath(c.req.query("next"));
  await setSignedCookie(c, STATE_COOKIE, `${state}|${next}`, c.var.secrets.cookieKey, cookieOptions(c, STATE_MINUTES * 60));
  return c.redirect(authorizeUrl(c.var.config, { redirectUri: redirectUri(c), state }));
});

authRoutes.get("/auth/callback", async (c) => {
  const cookie = await getSignedCookie(c, c.var.secrets.cookieKey, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/" });

  const error = c.req.query("error");
  if (error) return renderLoginError(c, error === "access_denied" ? "access_denied" : "provider_error", error);

  const [expectedState, next] = (cookie || "").split("|");
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code");
  if (!expectedState || !state || !timingSafeEqual(state, expectedState) || !code) {
    // Usually an expired or reused link (e.g. pressing Back after signing in). Starting over fixes it.
    return renderLoginError(c, "state_mismatch");
  }

  let tokens;
  try {
    tokens = await exchangeCode(c.var.deps.fetch, c.var.config, { code, redirectUri: redirectUri(c) });
  } catch (err) {
    if (err instanceof SweatStackError && err.code === "invalid_client") {
      await setAppState(c.env.DB, "last_token_error", `invalid_client: ${err.message}`);
      return renderLoginError(c, "invalid_client");
    }
    throw err;
  }

  const userInfo = await new SweatStackClient(c.var.deps.fetch, async () => tokens.access_token).getUserInfo();
  await c.var.tokens.saveUser(userInfo.sub, userInfo.name || userInfo.given_name || null, tokens);
  await setAppState(c.env.DB, "first_login_at", new Date().toISOString(), { onlyIfMissing: true });
  await setAppState(c.env.DB, "last_token_error", "");
  await startSession(c, userInfo.sub);
  return c.redirect(safeNextPath(next));
});

authRoutes.post("/auth/logout", (c) => {
  // Signs out of this browser only. Tokens stay, so notifications keep arriving. "Disconnect" removes them.
  endSession(c);
  return c.redirect("/");
});
