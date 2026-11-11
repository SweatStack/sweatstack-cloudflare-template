// /settings: notifications, data sources (SweatStack Portal), account.

import { Hono } from "hono";
import { endSession, requireUser } from "../auth/session";
import type { AppEnv } from "../env";
import { Layout } from "../views/Layout";
import { Card, CopyField, Icon, PageHeader } from "../views/components";

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/settings", requireUser, (c) => {
  const user = c.var.user!;
  const webhooksReady = c.var.config.webhookSecret !== "" && c.var.config.webhookSecretLooksValid;

  return c.html(
    <Layout title="Settings" user={user} active="settings">
      <PageHeader title="Settings" />

      <Card title="Notifications">
        <p>Get a notification on this device when a new activity arrives.</p>
        {/* public/app.js drives this block: it checks browser support, permission and the current subscription. */}
        <div class="push" data-push data-vapid-key={c.var.secrets.vapid.publicKey}>
          <p class="push-status muted" data-push-status role="status" aria-live="polite">
            Checking this device…
          </p>
          <div class="actions">
            <button type="button" class="btn btn-primary" data-push-enable hidden>
              <Icon name="bell" /> Turn on notifications
            </button>
            <button type="button" class="btn btn-secondary" data-push-test hidden>
              Send test notification
            </button>
            <button type="button" class="btn btn-ghost" data-push-disable hidden>
              Turn off
            </button>
          </div>
          <p class="muted small" data-push-ios-hint hidden>
            On iPhone and iPad, notifications work once you add this app to your Home Screen: tap Share, then{" "}
            <b>Add to Home Screen</b>, and open it from there.
          </p>
        </div>
        {!webhooksReady && (
          <p class="muted small">
            New-activity notifications aren't switched on for this app yet (the app's admin can do that on the Admin page). Test
            notifications work already.
          </p>
        )}
      </Card>

      <Card title="Data sources">
        <p>Connect or manage the services your activities come from, such as Garmin, Wahoo or Intervals.icu.</p>
        <form method="post" action="/settings/data-sources">
          {/* app.js sets this to 1 when running as an installed app, where a "Back" link can't reopen the app. */}
          <input type="hidden" name="standalone" value="0" data-standalone />
          <button type="submit" class="btn btn-secondary">
            Manage data sources <Icon name="external" />
          </button>
        </form>
      </Card>

      <Card title="Account">
        <p>
          Signed in as <b>{user.name ?? "SweatStack user"}</b>.
        </p>
        <CopyField id="user-id" label="Your SweatStack user id" value={user.id} />
        <div class="actions">
          <form method="post" action="/auth/logout">
            <button type="submit" class="btn btn-secondary">
              Sign out
            </button>
          </form>
        </div>
        <details class="danger-zone">
          <summary>Disconnect this app…</summary>
          <p>
            Deletes everything this app stores about you: your SweatStack connection and your notification subscriptions. Your
            data in SweatStack stays as it is. You can sign in again later.
          </p>
          <form method="post" action="/settings/disconnect">
            <button type="submit" class="btn btn-danger">
              Disconnect
            </button>
          </form>
        </details>
      </Card>

      <p class="muted small legal-links">
        <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a>
      </p>
    </Layout>,
  );
});

/** Sends the user to the SweatStack Portal to connect or manage data sources. */
settingsRoutes.post("/settings/data-sources", requireUser, async (c) => {
  const form = await c.req.parseBody();
  // An installed PWA can't be reopened by a link (iOS opens a browser tab instead), so leave out the
  // return link there: the Portal then tells the user to close the page. https://docs.sweatstack.no/learn/portal/
  const standalone = form.standalone === "1";
  const returnUrl = standalone ? undefined : `${new URL(c.req.url).origin}/settings`;
  const url = await c.var.sweatstack().createPortalSession("manage-integrations", returnUrl);
  return c.redirect(url, 303);
});

settingsRoutes.post("/settings/disconnect", requireUser, async (c) => {
  await c.var.tokens.deleteUser(c.var.user!.id);
  endSession(c);
  return c.redirect("/?disconnected=1", 303);
});

