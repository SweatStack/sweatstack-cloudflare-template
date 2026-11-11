import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { oauthError, testApp } from "./helpers";

describe("sign in with SweatStack", () => {
  it("redirects to SweatStack with client id, scopes and state, and without PKCE or prompt", async () => {
    const { request } = testApp();
    const response = await request("/auth/login");
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://app.sweatstack.no/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(env.SWEATSTACK_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/auth/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile activities:read offline_access");
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{30,}$/);
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  it("completes the flow: exchanges the code with the client secret and stores encrypted tokens", async () => {
    const { request, signIn, sweatstack } = testApp();
    const callback = await signIn("/activities?page=2");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/activities?page=2");

    const tokenCall = sweatstack.tokenCalls()[0]!;
    const params = new URLSearchParams(tokenCall.body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("client_secret")).toBe(env.SWEATSTACK_CLIENT_SECRET);
    expect(params.get("redirect_uri")).toBe("http://localhost/auth/callback");
    expect(params.has("code_verifier")).toBe(false);

    const row = await env.DB.prepare("SELECT * FROM users WHERE id = 'demo-athlete'").first<Record<string, string>>();
    expect(row?.name).toBe("Demo Athlete");
    expect(row?.access_token_enc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("access-1");
    expect(JSON.stringify(row)).not.toContain("refresh-1");

    const home = await request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Last activity");
  });

  it("rejects a callback with a wrong or missing state", async () => {
    const { request } = testApp();
    await request("/auth/login");
    const wrong = await request("/auth/callback?code=x&state=not-the-state");
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("expired");

    const fresh = testApp();
    const noCookie = await fresh.request("/auth/callback?code=x&state=anything");
    expect(noCookie.status).toBe(400);
  });

  it("never redirects to another site after sign-in", async () => {
    const { signIn } = testApp();
    const response = await signIn("https://evil.example/steal");
    expect(response.headers.get("location")).toBe("/");
  });

  it("explains a rejected client secret, and records it for /admin", async () => {
    const { signIn } = testApp({ onToken: () => oauthError("invalid_client", 401) });
    const response = await signIn();
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("SWEATSTACK_CLIENT_SECRET");
    const state = await env.DB.prepare("SELECT value FROM app_state WHERE name = 'last_token_error'").first<{ value: string }>();
    expect(state?.value).toContain("invalid_client");
  });

  it("explains access_denied (private app)", async () => {
    const { request } = testApp();
    await request("/auth/login");
    const response = await request("/auth/callback?error=access_denied");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("still private");
  });

  it("signs out with POST only, and requires a same-origin form post", async () => {
    const { request, signIn } = testApp();
    await signIn();
    const crossSite = await request("/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(crossSite.status).toBe(403);
    expect((await request("/settings")).status).toBe(200);

    const logout = await request("/auth/logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
    expect(logout.status).toBe(302);
    const settings = await request("/settings");
    expect(settings.status).toBe(302);
    expect(settings.headers.get("location")).toBe("/auth/login?next=%2Fsettings");
  });

  it("sets httpOnly, SameSite=Lax, Secure (on https) cookies", async () => {
    const { request } = testApp();
    const response = await request("https://app.example.com/auth/login");
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith("oauth_state="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Secure/i);
  });
});
