// Test helpers: a fake SweatStack (+ push services), an app wired to it, and a cookie-aware request helper.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { demoSweatStackFetch } from "../src/fixtures";
import { createApp } from "../src/index";

export type Call = { method: string; url: string; body: string; headers: Headers };

export type FakeOptions = {
  /** Called for POST /api/v1/oauth/token. Return a Response to override the default behaviour. */
  onToken?: (params: URLSearchParams) => Response | undefined | Promise<Response | undefined>;
  /** Status the fake push service answers with (201 = delivered, 410 = subscription gone). */
  pushStatus?: number;
};

/** A fake SweatStack API (demo data + token endpoint) and fake push services. Records every call. */
export function fakeSweatStack(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const demo = demoSweatStackFetch();
  let tokenCounter = 0;

  const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body = request.method === "GET" ? "" : new TextDecoder().decode(await request.clone().arrayBuffer());
    calls.push({ method: request.method, url: request.url, body, headers: request.headers });
    const url = new URL(request.url);

    if (url.hostname.endsWith("push.services.mozilla.com") || url.hostname === "fcm.googleapis.com") {
      return new Response(null, { status: options.pushStatus ?? 201 });
    }
    if (url.pathname === "/api/v1/oauth/token") {
      const params = new URLSearchParams(body);
      const custom = await options.onToken?.(params);
      if (custom) return custom;
      if (params.get("client_secret") !== env.SWEATSTACK_CLIENT_SECRET) return oauthError("invalid_client", 401);
      tokenCounter++;
      return Response.json({
        access_token: `access-${tokenCounter}`,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: `refresh-${tokenCounter}`,
        scope: "openid profile activities:read offline_access",
      });
    }
    return demo(request);
  };

  return { fetch, calls, tokenCalls: () => calls.filter((c) => c.url.endsWith("/api/v1/oauth/token")) };
}

export function oauthError(error: string, status = 400): Response {
  return Response.json({ error, error_description: error }, { status });
}

/** The app, a fake SweatStack behind it, and a request helper that keeps cookies like a browser. */
export function testApp(options: FakeOptions & { env?: Partial<Env> } = {}) {
  const sweatstack = fakeSweatStack(options);
  const app = createApp({ fetch: sweatstack.fetch });
  const testEnv = { ...env, ...options.env } as Env;
  const cookies = new Map<string, string>();

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `http://localhost${path}`;
    const headers = new Headers(init.headers);
    if (cookies.size) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", new URL(url).origin);
    const ctx = createExecutionContext();
    const response = await app.request(url, { ...init, headers, redirect: "manual" }, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (/max-age=0/i.test(cookie) || value === "") cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  }

  /** Runs the whole sign-in flow against the fake SweatStack. */
  async function signIn(next = "/"): Promise<Response> {
    const login = await request(`/auth/login?next=${encodeURIComponent(next)}`);
    const authorize = new URL(login.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    return request(`/auth/callback?code=test-code&state=${encodeURIComponent(state)}`);
  }

  return { app, env: testEnv, sweatstack, request, signIn, cookies };
}

export function form(data: Record<string, string>): RequestInit {
  return { method: "POST", body: new URLSearchParams(data), headers: { "content-type": "application/x-www-form-urlencoded" } };
}

export function json(data: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(data), headers: { "content-type": "application/json" } };
}
