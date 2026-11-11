// The Worker entry point: builds the Hono app, adds middleware in a fixed order, and mounts every route.
//
// Order matters:
//   1. request id, security headers, config        (every request)
//   2. /healthz                                    (no database needed)
//   3. app keys + token store                      (generated on first use, see secrets.ts)
//   4. /webhooks/sweatstack                        (signature-verified, no cookies, no CSRF check)
//   5. CSRF origin check, session                  (browser routes)
//   6. setup gate: incomplete config → /setup      (except /setup, /privacy, /terms, /design)
//   7. pages and actions

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { csrf } from "hono/csrf";
import { getCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { endSession, loadSession } from "./auth/session";
import { authRoutes } from "./auth/routes";
import { TokenStore } from "./auth/tokens";
import { readConfig } from "./config";
import type { AppEnv, Deps } from "./env";
import { activitiesRoutes } from "./pages/activities";
import { activityRoutes } from "./pages/activity";
import { adminRoutes } from "./pages/admin";
import { DEMO_PAGES, DEMO_SESSION_USER, designAccess, designRoutes } from "./pages/design";
import { demoActivities, demoSweatStackFetch } from "./fixtures";
import { renderErrorFragment, renderErrorPage } from "./pages/errors";
import { homeRoutes } from "./pages/home";
import { legalRoutes } from "./pages/legal";
import { settingsRoutes } from "./pages/settings";
import { setupRoutes } from "./pages/setup";
import { pushRoutes } from "./push/routes";
import { getAppSecrets } from "./secrets";
import { SweatStackClient } from "./sweatstack/client";
import { NotAuthenticatedError, SweatStackError } from "./sweatstack/http";
import { webhookRoutes } from "./webhooks/sweatstack";

/** Paths that work before the app is configured. */
const OPEN_PATHS = ["/setup", "/privacy", "/terms", "/design"];

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  // Requests that /design/pages/* sends through the app to render a real page with demo data.
  const demoRequests = new WeakMap<Request, (typeof DEMO_PAGES)[string]>();

  app.use(async (c, next) => {
    c.set("deps", deps);
    c.set("requestId", (c.req.header("cf-ray") ?? crypto.randomUUID()).slice(0, 16));
    c.set("config", readConfig(c.env));
    c.set("user", null);
    const demo = demoRequests.get(c.req.raw);
    if (demo) {
      const config = c.var.config;
      c.set(
        "config",
        demo.unconfigured
          ? { ...config, missing: ["SWEATSTACK_CLIENT_ID", "SWEATSTACK_CLIENT_SECRET"] }
          : { ...config, missing: [], adminUserIds: [...config.adminUserIds, DEMO_SESSION_USER.id] },
      );
    }
    await next();
    // Pages show personal data: never let a browser or proxy cache them.
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "private, no-store");
    // The light/dark choice from the theme toggle (a cookie set by public/app.js), applied server-side so
    // pages never flash in the wrong theme. No cookie: follow the device setting.
    const theme = getCookie(c, "theme");
    if ((theme === "light" || theme === "dark") && c.res.headers.get("content-type")?.startsWith("text/html")) {
      c.res = new HTMLRewriter()
        .on("html", { element: (html) => void html.setAttribute("data-theme", theme) })
        .transform(c.res);
    }
  });

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        // Forms post to this app; "Manage data sources" then redirects to the SweatStack Portal.
        formAction: ["'self'", "https://app.sweatstack.no"],
      },
      referrerPolicy: "same-origin",
    }),
  );

  app.get("/healthz", (c) => {
    const { missing, adminUserIds, webhookSecret } = c.var.config;
    return c.json({ ok: true, configured: missing.length === 0, admins: adminUserIds.length > 0, webhooks: webhookSecret !== "" });
  });

  app.use(async (c, next) => {
    const secrets = await getAppSecrets(c.env.DB);
    c.set("secrets", secrets);
    c.set("tokens", new TokenStore(c.env.DB, secrets.tokenKey, c.var.config, deps.fetch));
    await next();
  });

  app.route("/", webhookRoutes);

  app.use(csrf({ origin: (origin, c) => origin === new URL(c.req.url).origin }));
  app.use(loadSession);
  app.use(async (c, next) => {
    const demo = demoRequests.get(c.req.raw);
    if (demo) {
      c.set("user", demo.signedIn ? DEMO_SESSION_USER : null);
      const demoClient = new SweatStackClient(demoSweatStackFetch(), async () => "demo-token");
      c.set("sweatstack", () => demoClient);
      return next();
    }
    c.set("sweatstack", () => {
      const user = c.var.user;
      if (!user) throw new NotAuthenticatedError();
      return new SweatStackClient(deps.fetch, (options) => c.var.tokens.getAccessToken(user.id, options));
    });
    await next();
  });

  app.route("/", setupRoutes);
  app.route("/", legalRoutes);
  app.route("/", designRoutes);
  app.get("/design/pages/:name", designAccess, async (c) => {
    const page = DEMO_PAGES[c.req.param("name")];
    if (!page) return c.notFound();
    const path = page.path.replace(":demo", encodeURIComponent(demoActivities()[0]!.id));
    const target = new Request(new URL(path, c.req.url), { headers: c.req.raw.headers });
    demoRequests.set(target, page);
    return withDemoFragments(await app.fetch(target, c.env, c.executionCtx));
  });
  // htmx fragments inside a demo page (lazy chart, last-activity refresh) also come from demo data.
  app.get("/design/fragment/*", designAccess, async (c) => {
    const url = new URL(c.req.url);
    const target = new Request(new URL(url.pathname.replace("/design/fragment", "") + url.search, c.req.url), { headers: c.req.raw.headers });
    demoRequests.set(target, { path: target.url, signedIn: true });
    return withDemoFragments(await app.fetch(target, c.env, c.executionCtx));
  });

  app.use(async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const open = OPEN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
    if (c.var.config.missing.length > 0 && !open) {
      if (c.req.header("HX-Request")) {
        c.header("HX-Redirect", "/setup"); // a fragment request: navigate the whole page instead of swapping
        return c.body(null, 401);
      }
      return c.redirect("/setup");
    }
    await next();
  });

  app.route("/", authRoutes);
  app.route("/", homeRoutes);
  app.route("/", activitiesRoutes);
  app.route("/", activityRoutes);
  app.route("/", settingsRoutes);
  app.route("/", adminRoutes);
  app.route("/", pushRoutes);

  app.notFound((c) =>
    renderErrorPage(c, { status: 404, title: "Page not found", message: "There's nothing at this address.", retry: false }),
  );

  app.onError((error, c) => {
    // Deliberate HTTP errors from middleware (e.g. 403 from the CSRF check) keep their status.
    if (error instanceof HTTPException) return error.getResponse();
    const isFragment = Boolean(c.req.header("HX-Request"));

    if (error instanceof NotAuthenticatedError) {
      // The SweatStack connection ended (access revoked or expired). Start over cleanly.
      endSession(c);
      if (isFragment) {
        c.header("HX-Redirect", "/?signed_out=1");
        return c.body(null, 401);
      }
      return c.redirect("/?signed_out=1");
    }

    log(c.get("requestId"), c.req.method, c.req.path, c.get("user")?.id, error);

    if (error instanceof SweatStackError) {
      if (error.isNotFound && !isFragment) {
        return renderErrorPage(c, { status: 404, title: "Not found", message: "SweatStack has no such item for your account.", retry: false });
      }
      const message =
        error.status === 0 || error.status >= 500
          ? "SweatStack didn't respond as expected. This is usually temporary."
          : "SweatStack couldn't complete this request.";
      return isFragment ? renderErrorFragment(c, message) : renderErrorPage(c, { status: 502, title: "Couldn't reach SweatStack", message });
    }

    if (/no such table/i.test(error.message)) {
      return renderErrorPage(c, {
        status: 500,
        title: "Database not set up",
        message: "The database tables don't exist yet. Run `npm run db:migrate` (local) or `npm run db:migrate:remote` (production).",
      });
    }

    const message = "Something went wrong on our side.";
    return isFragment ? renderErrorFragment(c, message) : renderErrorPage(c, { status: 500, title: "Something went wrong", message });
  });

  return app;
}

/** Points a demo page's htmx requests (hx-get="/...") at /design/fragment/..., so they use demo data too. */
function withDemoFragments(response: Response): Response {
  return new HTMLRewriter()
    .on("[hx-get]", {
      element: (element) => {
        const target = element.getAttribute("hx-get");
        if (target?.startsWith("/")) element.setAttribute("hx-get", `/design/fragment${target}`);
      },
    })
    .transform(response);
}

/** One structured log line per error. Shown in the Cloudflare dashboard (Workers → Logs). */
function log(requestId: string | undefined, method: string, path: string, userId: string | undefined, error: Error) {
  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      method,
      path,
      userId,
      error: error.name,
      status: error instanceof SweatStackError ? error.status : undefined,
      message: error.message,
    }),
  );
}

const app = createApp({ fetch: (input, init) => fetch(input, init) });

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
