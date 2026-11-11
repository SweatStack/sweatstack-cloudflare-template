// Friendly error pages. Every message says what happened and what to do next.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../env";
import { Layout } from "../views/Layout";
import { Banner, ErrorBox, PageHeader, SignInButton } from "../views/components";

export type LoginErrorKind = "access_denied" | "provider_error" | "state_mismatch" | "invalid_client";

export function renderLoginError(c: Context<AppEnv>, kind: LoginErrorKind, detail?: string) {
  const status: ContentfulStatusCode = kind === "invalid_client" ? 502 : 400;
  return c.html(
    <Layout title="Sign-in didn't work">
      <PageHeader title="Sign-in didn't work" />
      {kind === "access_denied" && (
        <Banner tone="warn" title="Access wasn't granted">
          <p>You chose not to share your data, or this app is still private.</p>
          <p class="muted">
            New SweatStack apps are private: only the person who created the app can sign in until it goes live. If you run
            this app, see{" "}
            <a href="https://docs.sweatstack.no/learn/applications/going-live/">Going live</a>.
          </p>
        </Banner>
      )}
      {kind === "state_mismatch" && (
        <Banner tone="warn" title="This sign-in link has expired">
          <p>That can happen when you go back to an old page, or wait a long time before finishing. Please sign in again.</p>
        </Banner>
      )}
      {kind === "provider_error" && (
        <Banner tone="error" title="SweatStack reported a problem">
          <p>The error was: {detail}. Please try again.</p>
        </Banner>
      )}
      {kind === "invalid_client" && (
        <Banner tone="error" title="This app isn't set up correctly">
          <p>SweatStack didn't accept this app's credentials, so nobody can sign in right now.</p>
          <p class="muted">
            If you run this app: create a new client secret on your app's OAuth tab in{" "}
            <a href="https://app.sweatstack.no/settings/api">SweatStack</a>, and set it as{" "}
            <code>SWEATSTACK_CLIENT_SECRET</code> in Cloudflare (Worker → Settings → Variables and Secrets). Also check that{" "}
            <code>SWEATSTACK_CLIENT_ID</code> matches the app.
          </p>
        </Banner>
      )}
      {kind !== "invalid_client" && (
        <div class="actions">
          <SignInButton />
        </div>
      )}
    </Layout>,
    status,
  );
}

export function renderErrorPage(
  c: Context<AppEnv>,
  { status, title, message, retry = true }: { status: ContentfulStatusCode; title: string; message: string; retry?: boolean },
) {
  const url = new URL(c.req.url);
  return c.html(
    <Layout title={title} user={c.get("user")}>
      <PageHeader title={title} />
      <ErrorBox
        title={title}
        message={message}
        requestId={c.get("requestId")}
        {...(retry && c.req.method === "GET" ? { retryHref: url.pathname + url.search } : {})}
      />
      <p>
        <a href="/">Go to the home page</a>
      </p>
    </Layout>,
    status,
  );
}

/** A small error for htmx fragments: swapped into the page instead of a full error page. */
export function renderErrorFragment(c: Context<AppEnv>, message: string) {
  return c.html(<ErrorBox title="Couldn't load this" message={message} requestId={c.get("requestId")} />, 200);
}
