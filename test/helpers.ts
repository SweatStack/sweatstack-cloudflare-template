// Test helpers: a fake SweatStack (+ push services), an app wired to it, and a cookie-aware request helper.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import { demoSweatStackFetch } from "../src/fixtures";
import { createApp } from "../src/index";
import { base64urlDecode, base64urlEncode, concatBytes, utf8 } from "../src/lib/crypto";

/** One outgoing request. `body` is text (for JSON and forms); `bytes` is the raw body (for push payloads). */
/** Tests see the demo data as of this moment (a Wednesday), so they don't depend on today's date. */
export const TEST_NOW = new Date("2026-11-11T20:00:00Z");

export type Call = { method: string; url: string; body: string; bytes: Uint8Array<ArrayBuffer>; headers: Headers };

export type FakeOptions = {
  /**
   * Answer any request yourself, e.g. to make one SweatStack endpoint fail in one test:
   *   onRequest: (r) => (new URL(r.url).pathname === "/api/v1/activities/latest" ? new Response("", { status: 500 }) : undefined)
   * Return undefined to fall through to the demo data.
   */
  onRequest?: (request: Request) => Response | undefined | Promise<Response | undefined>;
  /** Called for POST /api/v1/oauth/token. Return a Response to override the default behaviour. */
  onToken?: (params: URLSearchParams) => Response | undefined | Promise<Response | undefined>;
  /** Status the fake push service answers with (201 = delivered, 410 = subscription gone). */
  pushStatus?: number;
};

/** A fake SweatStack API (demo data + token endpoint) and fake push services. Records every call. */
export function fakeSweatStack(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const demo = demoSweatStackFetch(TEST_NOW);
  let tokenCounter = 0;

  const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const bytes = request.method === "GET" ? new Uint8Array() : new Uint8Array(await request.clone().arrayBuffer());
    calls.push({ method: request.method, url: request.url, body: new TextDecoder().decode(bytes), bytes, headers: request.headers });
    const url = new URL(request.url);

    const custom = await options.onRequest?.(request.clone());
    if (custom) return custom;

    if (url.hostname.endsWith("push.services.mozilla.com") || url.hostname === "fcm.googleapis.com") {
      return new Response(null, { status: options.pushStatus ?? 201 });
    }
    if (url.pathname === "/api/v1/oauth/token") {
      const params = new URLSearchParams(new TextDecoder().decode(bytes));
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

// --- Push payloads -----------------------------------------------------------------------------
// Push messages are end-to-end encrypted (RFC 8291). Tests subscribe with the RFC's published test
// key pair, so they can decrypt what was sent and check the notification text.

/** A push subscriber whose private key is public (RFC 8291, Appendix A). Use it in tests only. */
export const RFC_SUBSCRIBER = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  privateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};

/** Stores a push subscription for `userId` that tests can decrypt (see pushMessages). */
export function subscribeForTest(userId: string, endpoint = `https://fcm.googleapis.com/fcm/send/${userId}`) {
  return env.DB.prepare("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 0)")
    .bind(endpoint, userId, RFC_SUBSCRIBER.p256dh, RFC_SUBSCRIBER.auth)
    .run();
}

/** Decrypts every push sent to a subscription made with subscribeForTest(), as notification objects. */
export async function pushMessages(calls: Call[]): Promise<Array<{ title: string; body: string; url: string; tag?: string }>> {
  const subscriber = await ecdhKeyPair(RFC_SUBSCRIBER.p256dh, RFC_SUBSCRIBER.privateKey);
  const pushes = calls.filter((c) => c.url.startsWith("https://fcm.googleapis.com/"));
  return Promise.all(pushes.map(async (c) => JSON.parse(await decryptPush(c.bytes, subscriber, base64urlDecode(RFC_SUBSCRIBER.auth)))));
}

export async function ecdhKeyPair(publicB64: string, privateB64: string): Promise<CryptoKeyPair> {
  const raw = base64urlDecode(publicB64);
  const jwk = { kty: "EC", crv: "P-256", x: base64urlEncode(raw.slice(1, 33)), y: base64urlEncode(raw.slice(33, 65)), d: privateB64, ext: true };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

/** The browser's side of RFC 8291: decrypts an aes128gcm push body. */
export async function decryptPush(body: Uint8Array<ArrayBuffer>, ua: CryptoKeyPair, authSecret: Uint8Array<ArrayBuffer>): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = { name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, ua.privateKey, 256));
  const hkdf = async (s: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
  const ikm = await hkdf(authSecret, secret, concatBytes(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  expect(plain.at(-1)).toBe(2); // last-record delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

export function form(data: Record<string, string>): RequestInit {
  return { method: "POST", body: new URLSearchParams(data), headers: { "content-type": "application/x-www-form-urlencoded" } };
}

export function json(data: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(data), headers: { "content-type": "application/json" } };
}
