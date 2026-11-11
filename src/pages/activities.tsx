// /activities: all activities, newest first, paginated with query params.
//   /activities?page=2&sport=cycling
// Every state is a plain URL: shareable, bookmarkable, and working without JavaScript.

import { Hono } from "hono";
import type { FC } from "hono/jsx";
import { APP } from "../app.config";
import { requireUser } from "../auth/session";
import type { AppEnv } from "../env";
import { formatSport } from "../lib/format";
import { Layout } from "../views/Layout";
import { ActivityList, Card, Empty, PageHeader, Pager } from "../views/components";

export const activitiesRoutes = new Hono<AppEnv>();

const MAX_PAGE = 500;

activitiesRoutes.get("/activities", requireUser, async (c) => {
  const page = parsePage(c.req.query("page"));
  const sport = parseSport(c.req.query("sport"));
  const sweatstack = c.var.sweatstack();

  // SweatStack doesn't return a total count, so ask for one extra item to know whether an older page exists.
  const [items, sports] = await Promise.all([
    sweatstack.listActivities({ limit: APP.pageSize + 1, offset: (page - 1) * APP.pageSize, sport }),
    sweatstack.getSports().catch(() => [] as string[]),
  ]);
  const hasOlder = items.length > APP.pageSize;
  const activities = items.slice(0, APP.pageSize);

  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    if (sport) params.set("sport", sport);
    if (p > 1) params.set("page", String(p));
    const query = params.toString();
    return query ? `/activities?${query}` : "/activities";
  };

  return c.html(
    <Layout title="Activities" user={c.var.user} active="activities">
      <PageHeader title="Activities" />
      <SportFilter sports={sports} selected={sport} />
      {activities.length > 0 ? (
        <Card class="card-flush">
          <ActivityList activities={activities} />
        </Card>
      ) : (
        <Card>
          <Empty title={page > 1 ? "No more activities" : sport ? `No ${formatSport(sport).toLowerCase()} activities` : "No activities yet"}>
            {page > 1 || sport ? (
              <p>
                <a href="/activities">Show all activities</a>
              </p>
            ) : (
              <p class="muted">Activities appear here once a data source is connected (see Settings).</p>
            )}
          </Empty>
        </Card>
      )}
      <Pager page={page} hasOlder={hasOlder} hrefFor={hrefFor} />
    </Layout>,
  );
});

const SportFilter: FC<{ sports: string[]; selected: string | null }> = ({ sports, selected }) =>
  sports.length < 2 && !selected ? null : (
    <form class="filter" method="get" action="/activities">
      <label for="sport">Sport</label>
      <select id="sport" name="sport" data-autosubmit>
        <option value="">All sports</option>
        {sports.map((s) => (
          <option value={s} selected={s === selected}>
            {formatSport(s)}
          </option>
        ))}
      </select>
      {/* Without JavaScript the select can't submit itself; app.js hides this button. */}
      <button class="btn btn-secondary btn-small js-hide" type="submit">
        Apply
      </button>
    </form>
  );

/** A page number from the query string: 1 for anything missing, invalid or out of range. */
export function parsePage(value: string | undefined): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1;
}

/** A sport filter from the query string, or null. Only OpenSportTaxonomy-shaped values pass. */
export function parseSport(value: string | undefined): string | null {
  return value && /^[a-z][a-z_]*(\.[a-z_]+)*(\+[a-z_]+)*$/.test(value) && value.length <= 64 ? value : null;
}
