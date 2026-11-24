# Release Notes — People Analytics

**Date:** 2026-12-02
**Migrations:** `20261202_1000_pev_actor_ws`, `20261202_1100_people_index` (revise `20261201_1000_ontology_create`)

---

## Overview

Analytics could say how many people were active. It could not say **who** signed in, what a
given person did on a given day, or who in a workspace has gone quiet. This release answers
those questions, per person and per workspace, from data the platform already records, and
backfills them from history.

| | |
|---|---|
| **New tab** | Analytics → **People** — everyone's activity, day by day, for the platform or one workspace |
| **New page** | `/analytics/people/:userId` — one person's year, their workspaces, every day and every event |
| **New workspace tab** | **Usage** — the same view, fixed to the workspace, for its admins |
| **New for everyone** | **Your activity** (`/me/activity`) in the user menu |
| **New API** | 5 endpoints under `/api/v1/admin/analytics/people` |
| **New background job** | The people indexer, on the scheduler-owner role |
| **Built for** | ~10,000 people and a year of history: every roster read costs people × days, never events (see [Scale](#scale)) |
| **Needs on upgrade** | Three migrations. No configuration. |

---

## What people can see

| Reader | Sees |
|---|---|
| Analytics administrators (`system:analytics:read`, or a grant that implies it) | Everyone, platform-wide or in any workspace, **including sign-ins** |
| Workspace admins (`workspace:admin`) | The people of **their** workspace: what happened in it. **No sign-ins**, no addresses, no platform-wide presence |
| Everyone | Themselves, everywhere, sign-ins included |
| The public Analytics tier (`analyticsPublicEnabled`) | Nothing more than before: an individual's timeline is not an aggregate |

A workspace admin reads only the ledger rows the Activity explorer already shows them
(`audience = 'workspace'`). An admin opening a private view stays auditor-only. Looking at
someone else's activity is itself recorded in the ledger, as `platform.people_activity.viewed`,
once per reader, person and scope every 30 minutes.

## What it shows

- **An activity line for every person.** Each roster row draws the person's actions per period
  on a scale shared by the page. Tick up to six people to overlay their lines on one chart, or
  switch the day-by-day card to **Lines** for a grid of small line charts, 24 people a page. Each
  person's page leads with their own line, the previous period behind it as a ghost, and their
  sign-ins beside it.
- **Who's active, day by day.** People by day on one scale, sortable and searchable. Pick a day
  to see who was around and what the day was made of.
- **What people do.** Six kinds of activity, plus Other: signed in, opened views, traced
  lineage, searched, built and edited, ran data operations. Each kind keeps one colour
  everywhere, and the top actions are listed by name.
- **Activity over time** by kind (drag to zoom), active against signed-in people, and a
  weekday × hour rhythm.
- **Idle sign-ins.** Days someone signed in and did nothing else.
- **Quiet members.** People with access who did nothing in the period, with when they joined
  and when they were last active there.
- **Where in the app.** Which sections people move to.
- **One person.** Their year as a calendar, their streak, a typical day, their standing among
  everyone active, every workspace they belong to with **when they joined it and were first and
  last active there**, their most-opened views, how they sign in and the failed attempts
  against their account, every day as a ribbon of sessions, and **everything they did** as a
  paged, filterable feed.

---

## Engineering

### Three stores, one count

- **`product_events`** holds usage signals.
- **`view_activity_log`** holds view edits. They are read here and **not** as the ledger's
  `visualization.view.*` copies, so each edit counts once. Reading this table also keeps edits
  visible when the outbox relay is not running.
- **`auth_audit_log`** holds everything else, sign-ins included.

Telemetry types that the ledger already records (`version.published`, `ontology.published`,
`view.import`, `view.export`) are skipped. Service accounts never count. Every read is one
table, and results are combined by id in Python, with no cross-domain JOINs.

### Scale

A roster that read raw events would cost what people *did*: thousands of people over a year is
tens of millions of rows. So nothing that reports on everyone reads an event table. The people
indexer folds each UTC day of all three stores into a rollup, and every roster, activity line
and day panel reads only that:

| Table | One row per | Holds |
|---|---|---|
| `person_activity_daily` | day × person × workspace × kind | count, first and last instant — and the same three for what a workspace admin may see (`n_ws`, …) |
| `people_daily_facets` | day × workspace × hour or event type | counts, with no person — the punchcard and "what people do" |

- **The roster** is a handful of `GROUP BY` reads whose results are one row per person, or per
  period and kind. Weekly windows are bucketed in SQL by a portable `CASE`.
- **The cached document is a summary**: numbers per person, no series, dates or addresses.
  Those are added per **page** (24 people): their lines, from `(user_id, day)`; their dates,
  from the timeline; addresses for privileged readers only.
- **The day panel** reads that day's rollup rows: exact, not a sample of the most active.
- **One person** reads the rollup for their totals, line and calendar; the details only raw
  events hold (types, hours, views opened) and their feed come from each store's actor index.
- Tests pin it: the roster runs the same statements with 10× the events and 9× the people, and
  never scans an event table (single-row `min`/`max` seeks for the coverage notes excepted);
  and every person's actions from the rollup equal a direct count of the raw events.

### New indexes

| Index | On | Columns |
|---|---|---|
| `idx_product_events_actor` | `product_events` | `actor_id`, `created_at` |
| `idx_val_actor_created` | `view_activity_log` | `actor`, `created_at` |

Both are built `CONCURRENTLY` on Postgres, and the migration recovers from an invalid build.
With them, one person's raw events are a range scan. (A third, on `product_events.workspace_id`,
was dropped again once the roster moved to the rollup: nothing read it, and an unread index still
costs every insert on the busiest table there is.)

### Caching

Documents are cached per lens, never per reader. They go through the same `_serve` as the rest
of Analytics: one computation per scope and window, then redacted per reader through
field allow-lists. The platform roster is warmed with the other surfaces. Workspace rosters and
person documents are read through.

### Backfill: the people indexer

The indexer runs on the scheduler-owner role, under an advisory lock, one **UTC day** per step in
its own transaction. Computing a day replaces it: delete, then insert the exact fold of that
day's events, so a day computed twice is the same day, and a restart resumes where it stopped.

**Which day next:** today (every minute) and yesterday (until it has closed); then days a late
ledger row made dirty (the relay recorded it after its day was computed); then history,
**newest first**, so the ranges people open first are complete first. Days older than raw
retention are never recomputed (the rows are gone), and the rollup keeps 400 days.

For each day:

1. **Attribution.** It fills `product_events.workspace_id`:
   - A view open belongs to its view's workspace. That is a fact.
   - A trace, search or export belongs to the workspace of the view the same person opened
     within the previous 30 minutes. That is an inference, and a signal with no such open
     stays unattributed rather than guessed.
2. **Timeline.** It builds `person_workspace_activity`, one row per (person, workspace) and
   one for the platform:
   - **Joined** comes from role bindings, from group membership (the later of the group's grant
     and the person joining the group), and from the ledger's `rbac.workspace.member_bound` /
     `member_joined` history. So someone who left and came back shows when they **first**
     joined.
   - **First and last active** come from all three stores.
   - The table outlives raw-event retention.

3. **The rollup.** The day's rows in `person_activity_daily` and `people_daily_facets`.

Figures are at most about two minutes behind, in line with the rest of Analytics. While history
is being indexed, the page says how far it has got and which days are still to come; join dates
read current grants live, so a new member shows their join date at once.

### Telemetry

- `POST /telemetry/events` accepts `workspaceId`, and keeps it only if the caller can read that
  workspace. The check uses the claims already on the request, so the hot path gains no query.
- The client sends the active workspace by default. Opening a view already switches to the
  view's workspace.
- New event type **`app.section`**: one row per move to another section of the app. It is
  presence, not activity, and is never counted as an action.

---

## API

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/v1/admin/analytics/people?workspace&q&sort&order&offset&limit` | Aggregates and one page of the roster, each person with their activity line |
| `GET` | `/api/v1/admin/analytics/people/lines?ids&workspace` | Up to 24 people's activity lines, to compare |
| `GET` | `/api/v1/admin/analytics/people/days/{YYYY-MM-DD}?workspace&limit` | Everyone active on that day, most active first |
| `GET` | `/api/v1/admin/analytics/people/{id}` | One person over the window (`id` may be `me`) |
| `GET` | `/api/v1/admin/analytics/people/{id}/calendar` | The last 365 days |
| `GET` | `/api/v1/admin/analytics/people/{id}/days/{YYYY-MM-DD}` | One day's events, in sessions |
| `GET` | `/api/v1/admin/analytics/people/{id}/events?before&kinds&limit` | Everything, newest first, keyset-paged |

Every endpoint takes the usual `days` or `from`/`to`, and `workspace`. A workspace admin must
name their workspace. A person a workspace admin may not see gets a **404**, the same answer a
non-existent id gets, so the endpoint cannot be used to discover who has an account.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PEOPLE_INDEX_INTERVAL_SECONDS` | `60` | Indexer cadence, with a floor of 15. Each pass works for at most 20 s. |

## Known limitations

- **Days are UTC**, like the rest of Analytics. Times on a day's timeline are UTC clocks.
- **Sessions are derived** from 30-minute gaps. The platform records no "session started".
- **Traces and searches recorded before this release** are placed in a workspace by the
  inference above. Where it cannot place one, that signal counts platform-wide only.
- **Figures need the indexer.** Rosters read only the rollup, which the scheduler-owner role
  keeps. On a deployment where it has never run, the page says so instead of computing a year of
  events on the request path.
- **The feed reaches back only as far as raw events are kept**: `PRODUCT_EVENT_RETENTION_DAYS`
  (400 by default) and `ACTIVITY_RETENTION_DAYS` (730). Join and first-activity dates persist
  beyond that.
- **Sign-ins come from the activity ledger.** On a deployment where the relay has never run, the
  page says sign-ins are unavailable rather than showing none.
