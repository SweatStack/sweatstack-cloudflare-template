// /admin: setup health, configuration status, webhook log and users. Only for ADMIN_USER_IDS.
// While ADMIN_USER_IDS is empty, any signed-in user sees how to become admin (their own id), nothing else.

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { requireUser } from "../auth/session";
import type { AppEnv } from "../env";
import { formatAgo } from "../lib/format";
import { sendToUser } from "../push/notify";
import { getAppState } from "../state";
import { Layout } from "../views/Layout";
import { Banner, Card, CheckItem, CopyField, PageHeader } from "../views/components";
import { renderErrorPage } from "./errors";
import { isPlaceholder, LEGAL_DOCUMENTS } from "./legal";
import { deploymentUrls } from "./setup";

export const adminRoutes = new Hono<AppEnv>();

type WebhookRow = { id: string; event_type: string; user_id: string | null; resource_id: string | null; status: string; detail: string | null; received_at: number };
type UserRow = { id: string; name: string | null; created_at: number; last_seen_at: number; devices: number };

adminRoutes.get("/admin", requireUser, async (c) => {
  const user = c.var.user!;
  const { config } = c.var;
  const urls = deploymentUrls(c);

  if (config.adminUserIds.length === 0) {
    return c.html(
      <Layout title="Admin" user={user}>
        <PageHeader title="Become an admin" />
        <Card>
          <p>
            No admins are set up yet. To make yourself admin, add your SweatStack user id as the <code>ADMIN_USER_IDS</code>{" "}
            secret ({urls.isLocal ? "in .dev.vars, then restart npm run dev" : "Cloudflare dashboard → this Worker → Settings → Variables and Secrets"}).
            Separate several ids with commas.
          </p>
          <CopyField id="admin-id" label="Your user id" value={user.id} />
        </Card>
      </Layout>,
    );
  }
  if (!user.isAdmin) return renderErrorPage(c, { status: 404, title: "Page not found", message: "There's nothing at this address.", retry: false });

  const db = c.env.DB;
  const [state, counts, webhooks, users] = await Promise.all([
    getAppState(db),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM users) AS users,
                (SELECT COUNT(*) FROM push_subscriptions) AS devices,
                (SELECT COUNT(*) FROM webhook_events WHERE received_at > ?) AS webhooks24h`,
      )
      .bind(Date.now() - 86400_000)
      .first<{ users: number; devices: number; webhooks24h: number }>(),
    db.prepare("SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 50").all<WebhookRow>(),
    db
      .prepare(
        `SELECT u.id, u.name, u.created_at, u.last_seen_at, COUNT(p.endpoint) AS devices
         FROM users u LEFT JOIN push_subscriptions p ON p.user_id = u.id
         GROUP BY u.id ORDER BY u.last_seen_at DESC LIMIT 50`,
      )
      .all<UserRow>(),
  ]);

  const webhookSecretSet = config.webhookSecret !== "";
  const legalPlaceholders = Object.values(LEGAL_DOCUMENTS).filter((doc) => isPlaceholder(doc.markdown));
  const testResult = c.req.query("test");

  return c.html(
    <Layout title="Admin" user={user} active="admin">
      <PageHeader title="Admin" subtitle="How this app is set up, and what it's doing." />

      {testResult && (
        <Banner tone={testResult.startsWith("sent:0") ? "warn" : "ok"} title="Test notification">
          <p>{describeTest(testResult)}</p>
        </Banner>
      )}

      <Card title="Setup">
        <ul class="checklist">
          <CheckItem ok={!state.last_token_error} title="SweatStack credentials">
            {state.last_token_error ? (
              <p>
                The last sign-in failed: <code>{state.last_token_error.value}</code>. Check <code>SWEATSTACK_CLIENT_ID</code> and
                create a new client secret on your app's OAuth tab in <a href="https://app.sweatstack.no/settings/api">SweatStack</a>.
              </p>
            ) : (
              <p class="muted">Client ID and secret are set and accepted by SweatStack.</p>
            )}
          </CheckItem>

          <CheckItem ok={Boolean(state.first_login_at)} title="Redirect URI registered">
            <p class="muted">Register the app's address as a redirect URI on your app's OAuth tab. It covers sign-in and the Portal's return link.</p>
            <CopyField id="redirect-uri" label="Redirect URI" value={urls.redirectUri} />
          </CheckItem>

          <CheckItem ok={webhookSecretSet && config.webhookSecretLooksValid && !state.last_webhook_error} title="Webhooks (new-activity notifications)">
            {!webhookSecretSet && (
              <ol class="steps">
                <li>
                  In SweatStack, open your app's <b>Webhooks</b> tab and add this endpoint:
                  <CopyField id="webhook-url" label="Webhook URL" value={urls.webhookUrl} />
                </li>
                <li>
                  Copy the signing secret (it starts with <code>whsec_</code>) into the <code>SWEATSTACK_WEBHOOK_SECRET</code> secret.
                </li>
              </ol>
            )}
            {webhookSecretSet && !config.webhookSecretLooksValid && (
              <p>
                <code>SWEATSTACK_WEBHOOK_SECRET</code> should start with <code>whsec_</code>. Copy it again from the Webhooks tab.
              </p>
            )}
            {state.last_webhook_error && (
              <p>
                Last rejected delivery ({formatAgo(state.last_webhook_error.updatedAt)}): {state.last_webhook_error.value}
              </p>
            )}
            {webhookSecretSet && <CopyField id="webhook-url" label="Webhook URL" value={urls.webhookUrl} />}
            {webhookSecretSet && (
              <p class="muted">
                {state.last_webhook_at ? `Last event received ${formatAgo(state.last_webhook_at.updatedAt)}.` : "No events received yet. They arrive when a connected user records an activity."}
              </p>
            )}
          </CheckItem>

          <CheckItem ok={legalPlaceholders.length === 0 ? true : null} title="Privacy policy and terms">
            {legalPlaceholders.length > 0 ? (
              <p>
                Still the template's placeholders: {legalPlaceholders.map((doc, i) => <>{i > 0 && ", "}<a href={doc.path}>{doc.title}</a></>)}. They
                don't block anything in the app, but as the operator you're responsible for them: edit{" "}
                <code>content/privacy.md</code> and <code>content/terms.md</code>.
              </p>
            ) : (
              <p class="muted">Your own documents are published.</p>
            )}
          </CheckItem>

          <CheckItem ok={null} title="Go live (when you're ready)">
            <p class="muted">
              New SweatStack apps are private: only you can sign in. Fill in the <b>Consent screen</b> tab and{" "}
              <a href="https://docs.sweatstack.no/learn/applications/going-live/">go live</a> to let others in. It asks for:
            </p>
            <CopyField id="privacy-url" label="Privacy policy URL" value={urls.privacyUrl} />
            <CopyField id="website-url" label="Website" value={urls.origin} />
          </CheckItem>
        </ul>
      </Card>

      <Card title="Activity">
        <dl class="stats">
          <div class="stat">
            <dt>Users</dt>
            <dd>{counts?.users ?? 0}</dd>
          </div>
          <div class="stat">
            <dt>Devices with notifications</dt>
            <dd>{counts?.devices ?? 0}</dd>
          </div>
          <div class="stat">
            <dt>Webhooks (24 h)</dt>
            <dd>{counts?.webhooks24h ?? 0}</dd>
          </div>
        </dl>
        <form method="post" action="/admin/test-push">
          <button type="submit" class="btn btn-secondary">
            Send a test notification to my devices
          </button>
        </form>
      </Card>

      <Card title="Recent webhooks" class="card-flush">
        {webhooks.results.length === 0 ? <p class="card-pad muted">None yet.</p> : <WebhookTable rows={webhooks.results} />}
      </Card>

      <Card title="Users" class="card-flush">
        <UserTable rows={users.results} />
      </Card>
    </Layout>,
  );
});

adminRoutes.post("/admin/test-push", requireUser, async (c) => {
  if (!c.var.user!.isAdmin) return c.text("Not found", 404);
  const summary = await sendToUser(c.env.DB, c.var.deps.fetch, c.var.secrets, new URL(c.req.url).origin, c.var.user!.id, {
    title: "Test from Admin",
    body: "Push notifications are working.",
    url: "/admin",
    tag: "test",
  });
  return c.redirect(`/admin?test=sent:${summary.sent},removed:${summary.removed},failed:${summary.failed}`, 303);
});

function describeTest(result: string): string {
  const counts = Object.fromEntries(result.split(",").map((part) => part.split(":"))) as Record<string, string>;
  if (counts.sent === "0" && counts.failed === "0" && counts.removed === "0") {
    return "You have no devices with notifications turned on. Turn them on in Settings first.";
  }
  return `Sent to ${counts.sent} device(s). Removed ${counts.removed} expired, ${counts.failed} failed.`;
}

const WebhookTable: FC<{ rows: WebhookRow[] }> = ({ rows }) => (
  <div class="table-scroll">
    <table class="table">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Event</th>
          <th scope="col">Outcome</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr>
            <td class="nowrap">{formatAgo(row.received_at)}</td>
            <td>
              <code>{row.event_type}</code>
            </td>
            <td>
              <span class={`badge badge-${row.status}`}>{row.status}</span>
            </td>
            <td class="muted small">{row.detail ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const UserTable: FC<{ rows: UserRow[] }> = ({ rows }) => (
  <div class="table-scroll">
    <table class="table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">User id</th>
          <th scope="col">Last seen</th>
          <th scope="col">Devices</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr>
            <td>{row.name ?? "–"}</td>
            <td>
              <code class="small">{row.id}</code>
            </td>
            <td class="nowrap">{formatAgo(row.last_seen_at)}</td>
            <td class="num">{row.devices}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
