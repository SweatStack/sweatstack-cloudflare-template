// Reusable view components. Each one maps to a CSS class in public/app.css.
// See them all, in every state, at /design.

import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { APP } from "../app.config";
import { activityTitle, formatDate, formatDistance, formatDuration, formatSport, formatTime, parseDuration, sportRoot } from "../lib/format";
import type { ActivitySummary } from "../sweatstack/types";

// --- Icons -----------------------------------------------------------------------------------
// Stroke icons on a 24px grid. They inherit the text colour.

const ICONS = {
  home: "M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  settings: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
  shield: "M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  chevron: "m9 6 6 6-6 6",
  back: "m15 6-6 6 6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  check: "m5 12.5 4.5 4.5L19 7.5",
  cross: "M6 6l12 12M18 6 6 18",
  dot: "M12 12h.01",
  copy: "M9 9h10v10H9zM5 15V5h10",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  // Sports
  run: "M13.5 5.5a1.5 1.5 0 1 0 0-.01M10 21l2.5-5.5L15 17v4M8 12.5l2.5-3 4 .5 2.5 3M12.5 15.5 14 10",
  ride: "M5.5 17.5a3 3 0 1 0 0-.01M18.5 17.5a3 3 0 1 0 0-.01M5.5 17.5 9 10h6l3.5 7.5M9 10l3 7.5M14 6h2.5l1.5 4",
  swim: "M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2-1.5 4.5-1.5S19 17 21 17M7 12.5 11 9l3 3 3-2M15.5 6.5a1.5 1.5 0 1 0 0-.01",
  pulse: "M3 12h4l2-5 4 10 2-5h6",
} as const;

export type IconName = keyof typeof ICONS;

export const Icon: FC<{ name: IconName; class?: string }> = ({ name, class: className }) => (
  <svg
    class={className ? `icon ${className}` : "icon"}
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d={ICONS[name]} />
  </svg>
);

export function sportIcon(sport: string): IconName {
  const root = sportRoot(sport);
  if (root === "running" || root === "walking" || root === "hiking") return "run";
  if (root === "cycling") return "ride";
  if (root === "swimming") return "swim";
  return "pulse";
}

// --- Layout pieces ---------------------------------------------------------------------------

export const PageHeader: FC<{ title: string; subtitle?: Child; back?: { href: string; label: string } }> = ({
  title,
  subtitle,
  back,
}) => (
  <div class="page-header">
    {back && (
      <a class="back-link" href={back.href}>
        <Icon name="back" /> {back.label}
      </a>
    )}
    <h1>{title}</h1>
    {subtitle && <p class="muted">{subtitle}</p>}
  </div>
);

export const Card: FC<PropsWithChildren<{ title?: string; class?: string; id?: string }>> = ({ title, class: className, id, children }) => (
  <section class={className ? `card ${className}` : "card"} id={id}>
    {title && <h2 class="card-title">{title}</h2>}
    {children}
  </section>
);

export const SectionLabel: FC<PropsWithChildren> = ({ children }) => <h2 class="section-label">{children}</h2>;

// --- Data display ----------------------------------------------------------------------------

export const StatTile: FC<{ label: string; value: string | null }> = ({ label, value }) =>
  value === null ? null : (
    <div class="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );

export const StatGrid: FC<PropsWithChildren> = ({ children }) => <dl class="stats">{children}</dl>;

/**
 * Where the data came from, e.g. "Garmin". Some platforms (Garmin) require this line wherever their data
 * is shown. Render it once per page, at the bottom: pass every attribution on the page, duplicates and
 * nulls included, and it lists each platform once.
 */
export const Attribution: FC<{ text: string | null | undefined | ReadonlyArray<string | null | undefined> }> = ({ text }) => {
  const names = [...new Set((Array.isArray(text) ? text : [text]).flatMap((t) => (t ? t.split(/,\s*| and /) : [])))];
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return <p class="attribution">Data from {list}</p>;
};

export const ActivityRow: FC<{ activity: ActivitySummary }> = ({ activity }) => {
  const distance = formatDistance(activity.summary?.distance?.sum);
  return (
    <li>
      <a class="activity-row" href={`/activities/${encodeURIComponent(activity.id)}`}>
        <span class="sport-badge">
          <Icon name={sportIcon(activity.sport)} />
        </span>
        <span class="activity-main">
          <span class="activity-title">{activityTitle(activity)}</span>
          <span class="activity-meta">
            {formatDate(activity.start_local)} · {formatSport(activity.sport)}
          </span>
        </span>
        <span class="activity-figures">
          <span class="num">{formatDuration(parseDuration(activity.duration))}</span>
          {distance && <span class="num muted">{distance}</span>}
        </span>
        <Icon name="chevron" class="row-chevron" />
      </a>
    </li>
  );
};

export const ActivityList: FC<{ activities: ActivitySummary[] }> = ({ activities }) => (
  <ul class="activity-list">
    {activities.map((activity) => (
      <ActivityRow activity={activity} />
    ))}
  </ul>
);

export const ActivityHeading: FC<{ activity: ActivitySummary }> = ({ activity }) => (
  <span class="activity-heading muted">
    {formatSport(activity.sport)} · {formatDate(activity.start_local)}, {formatTime(activity.start_local)}
  </span>
);

/** A chart rendered in the browser by public/training-chart.js. `summary` is the text alternative. */
export const Chart: FC<{ type: "line" | "bars" | "stack"; data: unknown; summary: string; label: string }> = ({ type, data, summary, label }) => (
  <training-chart type={type} data={JSON.stringify(data)} role="img" aria-label={label}>
    <p class="chart-fallback muted">{summary}</p>
  </training-chart>
);

// --- Feedback --------------------------------------------------------------------------------

export const Banner: FC<PropsWithChildren<{ tone?: "info" | "warn" | "error" | "ok"; title?: string; id?: string }>> = ({
  tone = "info",
  title,
  id,
  children,
}) => (
  <div class={`banner banner-${tone}`} role={tone === "error" ? "alert" : "status"} id={id}>
    {title && <p class="banner-title">{title}</p>}
    {children}
  </div>
);

export const Empty: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <div class="empty">
    <p class="empty-title">{title}</p>
    {children}
  </div>
);

export const ErrorBox: FC<{ title: string; message: Child; requestId?: string; retryHref?: string }> = ({
  title,
  message,
  requestId,
  retryHref,
}) => (
  <Banner tone="error" title={title}>
    <p>{message}</p>
    {retryHref && (
      <p>
        <a href={retryHref}>Try again</a>
      </p>
    )}
    {requestId && <p class="request-id">Reference: {requestId}</p>}
  </Banner>
);

// --- Controls --------------------------------------------------------------------------------

/**
 * "Sign in with SweatStack", following SweatStack's brand guidance: the official, unmodified mark,
 * the canonical label, and a subtitle naming accounts people already have.
 * https://docs.sweatstack.no/learn/brand/
 */
export const SignInButton: FC<{ next?: string }> = ({ next }) => (
  <a class="signin-button" href={next && next !== "/" ? `/auth/login?next=${encodeURIComponent(next)}` : "/auth/login"}>
    <img src="/brand/sweatstack-mark.svg" alt="" width="32" height="32" />
    <span>
      <span class="signin-label">Sign in with SweatStack</span>
      <span class="signin-subtitle">{APP.signInSubtitle}</span>
    </span>
  </a>
);

/** A read-only value with a Copy button (wired up in public/app.js). */
export const CopyField: FC<{ label: string; value: string; id: string }> = ({ label, value, id }) => (
  <div class="copy-field">
    <label for={id}>{label}</label>
    <div class="copy-row">
      <input id={id} type="text" value={value} readonly spellcheck={false} />
      <button type="button" class="btn btn-secondary btn-small" data-copy={id}>
        Copy
      </button>
    </div>
  </div>
);

export const Pager: FC<{ page: number; hasOlder: boolean; hrefFor: (page: number) => string }> = ({ page, hasOlder, hrefFor }) =>
  page === 1 && !hasOlder ? null : (
    <nav class="pager" aria-label="Pages">
      {page > 1 ? (
        <a class="btn btn-secondary" href={hrefFor(page - 1)} rel="prev">
          <Icon name="back" /> Newer
        </a>
      ) : (
        <span />
      )}
      <span class="muted num">Page {page}</span>
      {hasOlder ? (
        <a class="btn btn-secondary" href={hrefFor(page + 1)} rel="next">
          Older <Icon name="chevron" />
        </a>
      ) : (
        <span />
      )}
    </nav>
  );

/** One line of a setup checklist. `ok: null` means "optional / not applicable yet". */
export const CheckItem: FC<PropsWithChildren<{ ok: boolean | null; title: string }>> = ({ ok, title, children }) => (
  <li class={ok === true ? "check check-ok" : ok === false ? "check check-todo" : "check check-optional"}>
    <span class="check-icon">
      <Icon name={ok === true ? "check" : ok === false ? "cross" : "dot"} />
    </span>
    <div>
      <p class="check-title">
        {title}
        <span class="visually-hidden">{ok === true ? " (done)" : ok === false ? " (to do)" : " (optional)"}</span>
      </p>
      {children && <div class="check-body">{children}</div>}
    </div>
  </li>
);
