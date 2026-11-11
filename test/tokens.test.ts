import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TokenStore } from "../src/auth/tokens";
import { readConfig } from "../src/config";
import { decryptString } from "../src/lib/crypto";
import { loadAppSecrets } from "../src/secrets";
import { SweatStackClient } from "../src/sweatstack/client";
import { NotAuthenticatedError } from "../src/sweatstack/http";
import { fakeSweatStack, oauthError } from "./helpers";

const USER = "athlete-1";

async function setup(options: Parameters<typeof fakeSweatStack>[0] = {}, storeOptions = {}) {
  const sweatstack = fakeSweatStack(options);
  const secrets = await loadAppSecrets(env.DB);
  const store = new TokenStore(env.DB, secrets.tokenKey, readConfig(env), sweatstack.fetch, { pollMs: 10, ...storeOptions });
  await store.saveUser(USER, "Athlete", { access_token: "access-0", token_type: "Bearer", expires_in: 900, refresh_token: "refresh-0" });
  return { store, sweatstack, secrets };
}

async function expireAccessToken() {
  await env.DB.prepare("UPDATE users SET access_expires_at = ? WHERE id = ?").bind(Date.now() - 1000, USER).run();
}

describe("TokenStore", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("uses the stored access token while it is valid", async () => {
    const { store, sweatstack } = await setup();
    expect(await store.getAccessToken(USER)).toBe("access-0");
    expect(sweatstack.tokenCalls()).toHaveLength(0);
  });

  it("refreshes an expired token with the client secret, and stores the rotated refresh token", async () => {
    const { store, sweatstack, secrets } = await setup();
    await expireAccessToken();
    expect(await store.getAccessToken(USER)).toBe("access-1");

    const params = new URLSearchParams(sweatstack.tokenCalls()[0]!.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-0");
    expect(params.get("client_secret")).toBe(env.SWEATSTACK_CLIENT_SECRET);

    const row = await env.DB.prepare("SELECT refresh_token_enc, refresh_lock_until FROM users WHERE id = ?").bind(USER).first<{ refresh_token_enc: string; refresh_lock_until: number | null }>();
    expect(await decryptString(secrets.tokenKey, row!.refresh_token_enc)).toBe("refresh-1");
    expect(row!.refresh_lock_until).toBeNull();
    // Next call uses the new token without refreshing again.
    expect(await store.getAccessToken(USER)).toBe("access-1");
    expect(sweatstack.tokenCalls()).toHaveLength(1);
  });

  it("serializes concurrent refreshes: one token call, every caller gets the new token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { store, sweatstack } = await setup({
      onToken: async () => {
        await gate; // hold the first refresh open while the others arrive
        return undefined;
      },
    });
    await expireAccessToken();

    const results = Promise.all([store.getAccessToken(USER), store.getAccessToken(USER), store.getAccessToken(USER)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    expect(await results).toEqual(["access-1", "access-1", "access-1"]);
    expect(sweatstack.tokenCalls()).toHaveLength(1);
  });

  it("takes over when a lease holder died, using the still-valid old refresh token", async () => {
    const { store, sweatstack } = await setup({}, { leaseMs: 100 });
    await expireAccessToken();
    // Simulate a request that took the lease and crashed before finishing.
    await env.DB.prepare("UPDATE users SET refresh_lock_until = ? WHERE id = ?").bind(Date.now() + 100, USER).run();

    expect(await store.getAccessToken(USER)).toBe("access-1");
    expect(new URLSearchParams(sweatstack.tokenCalls()[0]!.body).get("refresh_token")).toBe("refresh-0");
  });

  it("forces a refresh when the API rejects the token (401), then retries once", async () => {
    const { store, sweatstack } = await setup();
    let first = true;
    const apiFetch = async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/api/v1/oauth/userinfo") {
        const auth = request.headers.get("authorization");
        if (first) {
          first = false;
          expect(auth).toBe("Bearer access-0");
          return new Response("expired", { status: 401 });
        }
        expect(auth).toBe("Bearer access-1");
      }
      return sweatstack.fetch(request);
    };
    const client = new SweatStackClient(apiFetch, (options) => store.getAccessToken(USER, options));
    expect((await client.getUserInfo()).sub).toBe("demo-athlete");
    expect(sweatstack.tokenCalls()).toHaveLength(1);
  });

  it("disconnects the user when SweatStack refuses the refresh token (revoked)", async () => {
    const { store } = await setup({ onToken: () => oauthError("invalid_grant") });
    await env.DB.prepare("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES ('https://fcm.googleapis.com/x', ?, 'k', 'a', 0)").bind(USER).run();
    await expireAccessToken();

    await expect(store.getAccessToken(USER)).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(USER).first()).toBeNull();
    expect(await env.DB.prepare("SELECT endpoint FROM push_subscriptions").first()).toBeNull();
  });

  it("releases the lease after a transient failure", async () => {
    const { store } = await setup({ onToken: () => new Response("down", { status: 503 }) });
    await expireAccessToken();
    await expect(store.getAccessToken(USER)).rejects.toThrow();
    const row = await env.DB.prepare("SELECT refresh_lock_until FROM users WHERE id = ?").bind(USER).first<{ refresh_lock_until: number | null }>();
    expect(row!.refresh_lock_until).toBeNull();
  });
});

describe("app secrets", () => {
  it("generates exactly one key set, even when first requests race", async () => {
    await env.DB.prepare("DELETE FROM app_secrets").run();
    const [a, b, c] = await Promise.all([loadAppSecrets(env.DB), loadAppSecrets(env.DB), loadAppSecrets(env.DB)]);
    expect(a.cookieKey).toBe(b.cookieKey);
    expect(b.cookieKey).toBe(c.cookieKey);
    expect(a.vapid.publicKey).toBe(c.vapid.publicKey);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM app_secrets").first<{ n: number }>())!;
    expect(n).toBe(4);
  });
});
