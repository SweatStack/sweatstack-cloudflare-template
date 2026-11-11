// The HTML shell for every full page. Fragments (htmx targets) never use this.

import type { FC, PropsWithChildren } from "hono/jsx";
import { APP } from "../app.config";
import type { SessionUser } from "../env";
import { Icon } from "./components";

export type NavItem = "home" | "activities" | "settings" | "admin";

type LayoutProps = PropsWithChildren<{
  title: string;
  user?: SessionUser | null;
  active?: NavItem;
}>;

export const Layout: FC<LayoutProps> = ({ title, user, active, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{title === APP.name ? title : `${title} · ${APP.name}`}</title>
      <meta name="description" content={APP.description} />
      <meta name="theme-color" content="#f6f6f3" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#101114" media="(prefers-color-scheme: dark)" />
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" href="/icons/logo.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      {/* No eval (strict CSP), no injected styles, and never cache signed-in pages in localStorage. */}
      <meta name="htmx-config" content='{"allowEval":false,"includeIndicatorStyles":false,"historyCacheSize":0,"selfRequestsOnly":true}' />
      <link rel="stylesheet" href="/app.css" />
      <script src="/vendor/htmx.min.js" defer></script>
      <script src="/app.js" type="module"></script>
      <script src="/training-chart.js" type="module"></script>
    </head>
    <body>
      <a class="skip-link" href="#main">Skip to content</a>
      <header class="topbar">
        <a class="brand" href="/">
          <img src="/icons/logo.svg" alt="" width="32" height="32" />
          <span>{APP.name}</span>
        </a>
        <div class="topbar-end">
        {user && (
          <nav class="tabs" aria-label="Main">
            <NavLink href="/" icon="home" label="Home" current={active === "home"} />
            <NavLink href="/activities" icon="list" label="Activities" current={active === "activities"} />
            <NavLink href="/settings" icon="settings" label="Settings" current={active === "settings"} />
            {user.isAdmin && <NavLink href="/admin" icon="shield" label="Admin" current={active === "admin"} />}
          </nav>
        )}
        {/* Light/dark switch (public/app.js). The choice is a cookie; src/index.ts applies it server-side. */}
        <button type="button" class="theme-toggle js-show" data-theme-toggle aria-label="Switch between light and dark mode">
          <Icon name="moon" class="icon-moon" />
          <Icon name="sun" class="icon-sun" />
        </button>
        </div>
      </header>
      <main id="main" class={user ? "page has-tabs" : "page"}>
        {children}
      </main>
      <footer class="footer">
        Powered by <a href="https://sweatstack.no">SweatStack</a>
      </footer>
    </body>
  </html>
);

const NavLink: FC<{ href: string; icon: "home" | "list" | "settings" | "shield"; label: string; current: boolean }> = ({
  href,
  icon,
  label,
  current,
}) => (
  <a href={href} aria-current={current ? "page" : undefined}>
    <Icon name={icon} />
    <span>{label}</span>
  </a>
);
