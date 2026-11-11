// SweatStack OAuth 2.0 endpoints, for a confidential client (one with a client secret).
// Guide: https://docs.sweatstack.no/learn/authentication/oauth2/
//
// Why no PKCE? SweatStack treats PKCE and the client secret as alternatives: when a flow starts with a
// code_challenge, the token exchange ignores the secret and issues a public-client token. This server-side
// app authenticates with its secret instead, and uses `state` against CSRF.

import { APP } from "../app.config";
import type { Config } from "../config";
import { errorFrom, fetchWithRetry, SWEATSTACK_URL, type Fetch } from "./http";
import type { TokenResponse } from "./types";

// Fixed values from https://app.sweatstack.no/.well-known/openid-configuration (a test checks them).
export const AUTHORIZE_URL = `${SWEATSTACK_URL}/oauth/authorize`;
export const TOKEN_URL = `${SWEATSTACK_URL}/api/v1/oauth/token`;

/** Where to send the browser to sign in. Don't add `prompt`: SweatStack shows consent only when needed. */
export function authorizeUrl(config: Config, { redirectUri, state }: { redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: APP.scopes.join(" "),
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** Exchanges the `code` from the callback for tokens. */
export async function exchangeCode(
  fetchFn: Fetch,
  config: Config,
  { code, redirectUri }: { code: string; redirectUri: string },
): Promise<TokenResponse> {
  return tokenRequest(fetchFn, config, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, false);
}

/**
 * Exchanges a refresh token for a new access token (and, with rotation, a new refresh token).
 * Retried once on a transient failure: SweatStack keeps the old refresh token valid for a short
 * grace window after rotating it, so repeating the request is safe.
 */
export async function refreshTokens(fetchFn: Fetch, config: Config, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(fetchFn, config, { grant_type: "refresh_token", refresh_token: refreshToken }, true);
}

async function tokenRequest(
  fetchFn: Fetch,
  config: Config,
  params: Record<string, string>,
  retry: boolean,
): Promise<TokenResponse> {
  const body = new URLSearchParams({ ...params, client_id: config.clientId, client_secret: config.clientSecret });
  const response = await fetchWithRetry(
    fetchFn,
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    },
    { retry },
  );
  if (!response.ok) throw await errorFrom(response, "Token request");
  const tokens = (await response.json()) as TokenResponse;
  if (!tokens.access_token) throw new Error("Token response has no access_token");
  return tokens;
}
