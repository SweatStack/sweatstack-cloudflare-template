// /setup: shown while SWEATSTACK_CLIENT_ID or SWEATSTACK_CLIENT_SECRET is missing.
// Walks through creating the SweatStack app, with the exact values for THIS deployment.

import { Hono, type Context } from "hono";
import type { FC } from "hono/jsx";
import type { AppEnv } from "../env";
import { Layout } from "../views/Layout";
import { Banner, Card, CopyField, PageHeader } from "../views/components";

export const setupRoutes = new Hono<AppEnv>();

/** URLs derived from where this app is running. Shown on /setup, the landing page and /admin. */
export function deploymentUrls(c: Context<AppEnv>) {
  const origin = new URL(c.req.url).origin;
  return {
    origin,
    /** Register this as the redirect URI: it covers /auth/callback and the Portal's return link. */
    redirectUri: `${origin}/`,
    webhookUrl: `${origin}/webhooks/sweatstack`,
    privacyUrl: `${origin}/privacy`,
    termsUrl: `${origin}/terms`,
    isLocal: isLocalhost(origin),
  };
}

export function isLocalhost(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

setupRoutes.get("/setup", (c) => {
  const { missing } = c.var.config;
  if (missing.length === 0) return c.redirect(c.var.user?.isAdmin ? "/admin" : "/");
  const urls = deploymentUrls(c);

  return c.html(
    <Layout title="Set up your app">
      <PageHeader
        title="Set up your app"
        subtitle="This app is deployed. Connect it to SweatStack in about five minutes; you only do this once."
      />

      <Card title="1. Create a SweatStack app">
        <ol class="steps">
          <li>
            Open <a href="https://app.sweatstack.no/settings/api">SweatStack → Settings → API</a> and click <b>New App</b>.
          </li>
          <li>
            Give it a name, and under <b>Data your app uses</b> tick <b>Activities: read</b>.
          </li>
          <li>
            Add this <b>redirect URI</b>:
            <CopyField id="redirect-uri" label="Redirect URI" value={urls.redirectUri} />
          </li>
          <li>
            On the app's <b>OAuth</b> tab, under <b>Client secrets</b>, create a secret. Copy it right away: SweatStack shows it
            only once.
          </li>
        </ol>
      </Card>

      <Card title={urls.isLocal ? "2. Add the credentials to .dev.vars" : "2. Add the credentials to Cloudflare"}>
        {urls.isLocal ? (
          <p>
            Copy <code>.dev.vars.example</code> to <code>.dev.vars</code>, fill in the values below, and restart{" "}
            <code>npm run dev</code>.
          </p>
        ) : (
          <p>
            In the <a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages">Cloudflare dashboard</a>, open this
            Worker → <b>Settings</b> → <b>Variables and Secrets</b>, and add each value as a <b>Secret</b>. The app picks them up
            within seconds.
          </p>
        )}
        <ul class="secret-list">
          <SecretStatus name="SWEATSTACK_CLIENT_ID" hint="The Client ID from the OAuth tab." missing={missing.includes("SWEATSTACK_CLIENT_ID")} />
          <SecretStatus name="SWEATSTACK_CLIENT_SECRET" hint="The secret you just created." missing={missing.includes("SWEATSTACK_CLIENT_SECRET")} />
        </ul>
        <p class="muted">
          Optional, can be added later: <code>ADMIN_USER_IDS</code> (your SweatStack user id, shown on Settings after you sign
          in) and <code>SWEATSTACK_WEBHOOK_SECRET</code> (for notifications, explained on the Admin page).
        </p>
        <p>
          <a class="btn btn-primary" href="/setup">
            Check again
          </a>
        </p>
      </Card>

      <Card title="3. Before others can sign in">
        <p>
          New SweatStack apps are <b>private</b>: only you can sign in. To open it to others, fill in your app's{" "}
          <b>Consent screen</b> tab and <a href="https://docs.sweatstack.no/learn/applications/going-live/">go live</a>. These
          pages of this app are ready for the links it asks for:
        </p>
        <CopyField id="privacy-url" label="Privacy policy" value={urls.privacyUrl} />
        <CopyField id="website-url" label="Website" value={urls.origin} />
        <Banner tone="warn">
          <p>
            The <a href="/privacy">privacy policy</a> and <a href="/terms">terms</a> are placeholders. Replace them with your
            own (<code>src/pages/legal.tsx</code>) before you go live.
          </p>
        </Banner>
      </Card>
    </Layout>,
  );
});

const SecretStatus: FC<{ name: string; hint: string; missing: boolean }> = ({ name, hint, missing }) => (
  <li class={missing ? "check check-todo" : "check check-ok"}>
    <code>{name}</code> <span class={missing ? "badge badge-todo" : "badge badge-ok"}>{missing ? "missing" : "set"}</span>
    <p class="muted">{hint}</p>
  </li>
);
