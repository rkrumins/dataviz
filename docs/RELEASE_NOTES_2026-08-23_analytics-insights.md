# Release Notes — Analytics & Product Insights

**Branch:** `claude/analytics-dashboard-insights-clrxbl` · **Date:** 2026-08-23
**Scope:** 24 commits · 96 files · +15,796 / −31
**Migration:** `20260821_1200_event_subject` (revises `20260817_1400_recon_pause`)

---

## Overview

The platform had operational telemetry — job queues, provider health, cache hit rates — and
nothing that answered the question a business actually asks: **is this growing, and is anyone
getting value out of it?** Almost every number in this release was already in the database
and had simply never been read.

This adds a top-level **Analytics** destination at `/analytics` with six tabs, a range control
every chart obeys, server-computed narrative insights, and a privacy model that lets the
section be opened to everyone without publishing anything that identifies a person.

It also closes the gap underneath it. The dashboard could prove people *opened views*. It
could not prove anyone ever *traced lineage*, which is the entire point of the product. Seven
new product events instrument the value moments, and activation is now scored on tracing
rather than on authoring.

| | |
|---|---|
| **New destination** | `/analytics` — Overview, Growth, Engagement, Content, Health, Workspaces |
| **New API** | 3 analytics endpoints, 1 content-insights endpoint, 7 new telemetry event types |
| **New permission** | `system:analytics:read` (seeded on `super_admin`, `org_admin`, `org_auditor`) |
| **New settings** | 4 feature flags in a new **Analytics** admin category |
| **Ships on** | Nothing. Analytics is privileged-only until an operator opens it. |
| **Needs on upgrade** | One migration. No configuration required. |

**Read [Upgrading](#upgrading) before deploying** — the migration backfills `product_events`,
and two of the four new flags widen disclosure if you turn them on.

---

# Part 1 · Business / Executive Release Notes

### 1. A dashboard that answers "is this growing?"

Six tabs, one range control (7d / 14d / 30d / 90d / 6m / 1y, plus any custom range), and every
chart, stat and table on the page re-renders against it — so the numbers on a page always
agree with each other.

- **Overview** — the headline numbers, and what changed, in sentences.
- **Growth** — sign-ups, where they came from, retention cohorts, cumulative growth.
- **Engagement** — activity, stickiness (DAU/MAU), the activation funnel.
- **Content** — views, who builds them, what gets opened, what never does.
- **Health** — data freshness, access-request backlog, invite acceptance, ontology coverage.
- **Workspaces** — what the estate is made of, plus a per-workspace drill-in.

### 2. It measures value, not just attention

The old telemetry was five event types, all of them about whether *we* explained ourselves —
docs votes, tour completion. None of it said whether anyone got an answer.

Seven product actions are now instrumented: tracing lineage, searching the graph, exporting,
publishing a revision, publishing an ontology — and, separately, **the failures**:
`lineage.trace_empty` and `graph.search_miss`. A trace that comes back with no lineage is a
*failed* value moment, and no other number on the dashboard can see it: view opens, activity
and stickiness all count it as engagement.

**Activation is now scored on tracing rather than on creating a view.** Building a view is a
later, heavier commitment; scoring activation on it measured investment rather than value, and
undercounted every reader who got exactly what they came for and left.

### 3. Usage figures on the content itself, for the people who can act on them

Analytics only ever answered "is anyone using this?" for someone who navigated to the
dashboard — and the people best placed to act on it, the person who built a view and the team
that owns it, have no reason to go there and often no permission to.

The view page now carries opens, distinct viewers and a trend beside the view's name. The
shape matters as much as the total: 1,800 opens could be a steady habit or one burst six
months ago, and the count alone cannot tell them apart. A view nobody has opened says so in
words rather than showing a zero, which reads as a broken counter rather than as the most
useful thing its author could learn.

This is deliberately **not** behind the analytics gate. If you may open a view, you may know
how much it is opened.

### 4. What changed, in sentences

Above the Overview charts sits a strip of server-computed observations, ranked by
significance: what moved, by how much, and whether it is good news. Every rule is a pure
function of the finished summary document, so an insight can never contradict the chart
beneath it — and every rule is guarded, so a young install gets silence rather than five
findings manufactured from three users.

### 5. Every metric says what it means

Stickiness, activation, reach and concentration are terms a business reader would otherwise
have to guess at, and guessing produces confident misreadings. Twenty-five definitions answer
three questions in order: **what** it counts, **how** it is computed, and **what to do** if it
moves. That third question is a design filter as much as help text — a metric with no decision
attached probably should not be on the page.

### 6. A public tier that redacts rather than omits

`analyticsPublicEnabled` opens the section to every signed-in person under one rule:
**aggregates are public, identities are not.**

Counts and trends cover the whole platform *including* workspaces the reader cannot open — an
answer that silently drops three quarters of the tenancy is worse than no answer, because two
people read different totals off one page and both believe it. What they cannot have is names:
a workspace they are not in is a **locked row that still counts toward the totals**, and
per-person activity is withheld from everyone non-privileged.

Nothing is removed; it is locked and explained. A withheld panel draws a synthetic silhouette
of the missing component in the real geometry, keeps its heading and description, and says why
it is hidden. A locked workspace row offers to request access — turning a dead end into the
queue the access-friction metrics on the Health tab already measure.

### 7. Analytics now follows the app's permission model

Analytics was **stricter** than the product it reports on, in four places. Being over-cautious
is not the harmless direction to be wrong in: a dashboard that hides what the rest of the app
shows teaches people its numbers are unreliable.

- `system:org-viewer` already short-circuits every workspace read across the tenancy;
  Analytics ignored it, so someone who can open every workspace in the product saw locked rows.
- `visibility='enterprise'` means published platform-wide, and Analytics hid the name anyway —
  on exactly the "most popular items" a reader should see.
- A view's creator keeps reach to their own work everywhere else; here they did not.
- Email addresses were withheld at every level, while `GET /views/{id}` has always returned
  `createdByEmail` and the Explorer drawer has always rendered it as a `mailto:` link.

None of that was policy. It was Analytics re-deciding facts that `view_access` and
`permission_service` already own, and it is fixed by asking them.

### 8. A brand-new deployment gets guidance, not six empty charts

A tenant with nothing in it used to render an empty hero, four zero tiles with flat sparklines,
and six panels each saying "no activity in this range" — which reads as a broken dashboard on a
dead product. It is neither: nothing has happened because nothing has been set up. Overview now
leads with the steps that fix it, each gated on whether *this* reader can actually take it. An
operator who cannot invite anyone is not told to invite someone.

### 9. Charts you can read, and read correctly

- **The previous period is a real column on a real axis.** Both periods sit end to end on one
  continuous time axis, every bar on the date it happened, with a dashed divider and in-plot
  captions naming each half. The earlier period is hatched and outlined — a categorical
  difference carried by texture, so it survives greyscale, low contrast and every kind of
  colour blindness.
- **The cost, stated rather than hidden:** pick 30 days and the axis spans 60, so each bar is
  half as wide. It is in the subtitle and in the captions.
- **Every chart has a table twin**, a legend past one series, and hover targets bigger than the
  marks. No chart has two y-axes.
- **The palette was validated, not chosen.** Candidate slot orderings were run through a
  colour-vision validator: worst adjacent CVD ΔE 10.3 light / 8.1 dark, normal-vision 26.4 /
  22.6, contrast ≥ 3:1 in both modes.

---

# Part 2 · Engineering Release Notes

## 2.1 Reading a JSON payload does not scale, and this table grows with usage

`product_events` kept what an event was **about** inside its JSON payload, which no portable
SQL can group on. Counting opens per view therefore meant selecting every event in the window
and decoding it in Python, alongside a map of the entire views table — on the one table
designed to grow with usage. The dashboard's cost was linear in how successful the product
was, which is the wrong direction for a number to run in.

`subject_id` is that view id in a real column, indexed `(event_type, subject_id, created_at)`.
Both aggregates become grouped queries, and what comes back is one row per view that was
opened rather than one per open — so the workspace rollup resolves the few thousand views that
were actually touched, not the whole catalogue.

**Measured on 200k opens across 2,000 views over 90 days:**

| | before | after |
|---|---:|---:|
| Full-window fold | 1345 ms | **401 ms** |
| One view's usage | 1345 ms | **2.4 ms** |

The second number is the one that matters. Usage *on the content itself* was not affordable
while the answer required folding the whole window; as an indexed lookup it is.

The writer sets the column from an id it already holds, so the open path gains no query. The
workspace stays deliberately absent from the event — resolving it would put a `SELECT` on a
path that runs every time anyone opens anything, and grouping by view first makes it
unnecessary.

## 2.2 Cache the document, redact per reader

The cache was keyed on a fingerprint of the caller's visible workspaces. That was the correct
fix for the leak it was written against — an entry keyed on the window alone let an
administrator warming the cache hand their unredacted document to the next non-privileged
reader — but it priced the platform out of its own dashboard. Readers with different access
never shared an entry, so a few hundred concurrent users with a few hundred distinct workspace
sets meant a few hundred full recomputations per TTL. **The cache worked hardest exactly when
it needed to help most.**

The audience was in the key because the *redacted* document was in the value.
`platform_summary` and `workspace_rows` touch `scope` only on their final line, as a pure
projection over a finished document — so cache the unredacted one and the problem dissolves.
One computation serves every reader; what each of them receives is still computed from their
own scope on every request.

`_serve` is now the only way anything leaves that cache, and it cannot return a document
without applying a redactor. It **deep-copies first**: in-process hits hand back the same
object every time and the redactors assign into what they are given, so redacting in place
would edit the shared entry and serve the first reader's redaction to the second.

Layers, in order:

1. **Single-flight** — the thundering herd collapses to one computation.
2. **60 s TTL** — sequential repeats (an admin switching tabs) never recompute.
3. **Redis where reachable, per-replica otherwise** — a cache outage must not take down a
   read-only page.
4. **A warmer on the scheduler-owner role** — recomputes the six preset windows every 300 s
   and writes them with a TTL three passes long, so no reader ever pays for an aggregation and
   a stalled pass degrades to staler numbers rather than to a stampede.

The warmer is purely an optimisation. A cold key, a custom range, a per-workspace drill-in, or
a deployment with no scheduler role still works through the read-through path exactly as
before. Nothing here can break the dashboard by failing.

Documents are minutes old by design, so the header says so relatively — "as of 3 min ago",
with the exact instant on hover. A stall becomes the first thing anybody notices rather than
something they never learn.

**Negative results are never stored**, so walking random workspace ids cannot grow memory.

## 2.3 The cache key carries a schema version

Analytics documents are precomputed into Redis and **outlive the code that wrote them**, by a
TTL measured in minutes. Adding a field to a cached document therefore guarantees a window in
which a freshly-deployed client is handed the old shape — which is exactly how
`series.previous.buckets is not iterable` took the Growth tab into the route error boundary.

`SCHEMA_VERSION` is now part of the key, so a shape change is a cache miss rather than a
puzzle. The client half is defensive too: `comparedSeries` returns `null` unless the previous
period has a date for **every** value, and the tabs then draw this period alone — the honest
answer when we do not know *when* the older numbers happened, and specifically **not** a
fallback to placing them by index, which is the bug the shared axis exists to remove and which
fails silently rather than loudly. The legend drops its entry too: a key for a mark that is not
on the plot is its own small lie.

## 2.4 Redaction is a projection with one exit

Two leaks reached `main` during this feature, and both were one endpoint failing to do what its
neighbours did.

- **`createdBy` rode out on redacted rows.** It was added so the redactor could honour a
  creator's reach to their own work; both branches of `_redact_view_row` then spread `**row`,
  so every redacted view carried its author's user id to a reader who could not see the view's
  name. A user id is precisely the "individual activity" the strict level exists to withhold.
- **`workspace_detail` returned its document unfiltered.** Its only guard was `can_see` — *may
  Analytics report on this workspace?* — which is an **access** decision, and access is not the
  same question as *what may this document contain*. So the drill-in shipped `topContributors`
  with names and addresses to every reader the first check let through, at every privacy level.
  `analyticsWorkspaceVisibility` is what turns that from untidy into dangerous: it satisfies
  `can_see` for every workspace.

Both are fixed structurally rather than patched:

- Rows are projected through an explicit **allow-list** of fields that may leave. A column
  added to a ranking query in future is withheld by default until someone names it on purpose —
  the opposite of a spread, which publishes whatever the query happened to select.
- Every function has a **single exit through a redactor**, so a field added below cannot bypass
  the scope by being added below.
- `can_see` and `can_open` are separate predicates, and **only `can_open` may render a link or
  resolve a drill-in**. Reporting on something is not a door into it.

And three sweeps that fail loudly rather than quietly:

1. One serialises a redacted document and searches it for identifiers the viewer has no
   business receiving, so a leak through an unconsidered field breaks the build.
2. One does the same over the **HTTP response body**, because the repo's return value is not
   what reaches a browser and a serialisation change could reopen this without touching the
   repo at all.
3. One **router-walking** sweep enumerates the mounted analytics routes rather than a list
   someone has to remember to update, and asserts no address or internal-only field appears in
   any response a non-privileged reader can obtain.

A fourth asserts the sweep can **fail** — it runs the same search over a privileged document
and requires the identifiers to be present there. A guard that cannot fail proves nothing.

Client-side, `WithheldPanel` takes no children by its type signature, so it cannot be handed
real data to hide, and the only blur in the section sits over a synthetic silhouette with no
values in it. The obvious treatment — frosted glass over the real thing — is a security bug:
CSS blur is a paint effect and every value stays one view-source away. **Redaction is
server-side; the browser is never sent the data at all.**

## 2.5 Failing closed silently is its own bug class

`redact_summary` filters the narrative strip through three allow-lists and drops anything
unlisted. Failing closed is the right default — an unreviewed rule should not reach a public
tier automatically — but it is **silent**: the rule fires, the key is dropped, and every
non-privileged reader simply never sees it while nothing errors and no test goes red.

That is what happened to `views-not-opened`, which shipped visible to administrators and
auditors only — the opposite of the point, since the insight names no person and no workspace.

Fixed, and a test now cross-checks every key any rule can emit against the three lists **in
both directions**: an unclassified rule fails, and so does an allow-listed key no rule emits.
It scans the source rather than running the rules, so a rule needing a rare document to fire is
still checked.

## 2.6 Instrumentation that covers both trace paths

Tracing lineage is the product's value moment and there are two paths to it: `useUnifiedTrace`
(GraphCanvas and HierarchyCanvas) and `useCanvasTraceWalk` (every trace on a Context View).
Only the first was instrumented — and Context View is the flagship type, and the surface a
shared trace link now opens into. The activation funnel's "traced lineage" stage was measuring
one canvas and reporting on the whole product.

Two decisions worth stating:

- **Recorded when the walk settles, not when it starts.** `start` only names a focal; the walk
  fetches in waves, so at that moment there is no answer yet — and "did asking for lineage
  produce any?" is exactly the half worth measuring. A `checkpoint` counts as settled. An
  errored walk counts as neither, because a failure is not a value moment and it is not an
  empty lineage either.
- **Presses are counted, not focals.** Re-tracing the focal already on screen leaves
  `tracedUrn` untouched and refetches nothing, so a naive guard would silently drop the second
  ask — while the other path records every press. Two surfaces counting the same action
  differently would make the metric mean whichever canvas someone happened to be on.

## 2.7 Query discipline

- Every aggregate is a **single-table `GROUP BY` stitched by id in Python**. `DOMAIN_OWNERSHIP`
  forbids cross-domain JOINs and the lint baseline does not move (cross-domain JOIN baseline
  holds at 12).
- Day-bucketing is `substr(col, 1, 10)`, which the schema's ISO-8601 TEXT timestamps make valid
  and identical on SQLite and Postgres.
- `GET /insights/views` is **three queries per request whatever the batch size** — one to
  scope, two to aggregate — and a test pins that, because the moment it becomes O(ids) a
  gallery goes from three queries to three per tile.
- Active users come from **activity, not sign-ins**: `auth_audit_log` is filled by a relay that
  only runs on the scheduler-owner role, so on a web-only replica it is empty, and its user id
  lives inside a JSON payload. Doing something is also a truer read on engagement than signing
  in and bouncing.

## 2.8 Retention

`product_events` had no retention because its contents used to be rare. It now takes a row per
view open, lineage trace and graph search, so it grows with usage. A daily sweep on the
scheduler-owner role keeps **400 days**, clamped so a misconfigured horizon can never make a
year-long chart lie.

## 2.9 One word for one thing

The database stores `reference`; every surface in the product calls that a **Context View**.
That mapping had been written out by hand in four places — `ViewEditor`, `ViewWizard`,
`CanvasRouter` and the backend's `allowedViewModes` — which was fine until a fifth surface
appeared and did not know. Analytics was the fifth, and rendered the raw enum.
`lib/domainLabels.ts` is now the single source and all five read it, with a test pinning
`reference → Context View` from both sides.

Renaming the stored value was the other option and is the wrong one: a migration across
`view_type`, saved configs, the flag and every persisted layout, in exchange for nothing anyone
can see.

## 2.10 A visual harness, because the privacy postures cannot be checked by hand

Seeing the strict view needs a second account with no workspace bindings and two feature flags
set a particular way. The redaction work shipped twice with nobody having looked at it.

`npm run harness:analytics` renders the real components against hand-built fixtures with no
API — one fixture per posture — and drives Chromium over each. Every one of the following was
something the screenshots showed and the unit tests were happy with:

- Overview plotted ~180 active users and ~2,400 view opens on one axis, drawing the smaller
  series as a flat line along the baseline. That is a rendering artefact, not a finding. Three
  measures now get three frames.
- "Cumulative growth" had the same fault across users (thousands), workspaces (tens) and views.
  Indexed to 100 at the start of the window, with the table keeping absolute counts beside the
  index.
- A ghost line had no legend entry, so a single-series chart drew two lines and offered no key.
- Endpoint labels were suppressed by series *count*, which is the wrong test — three endpoints
  landing within a few pixels overprint however few they are. Now suppressed by proximity.
- An annotation's only label was an SVG `<title>` — a tooltip that does not print, does not
  survive a screenshot and cannot be reached by keyboard.
- The Health tab drew leaderboard silhouettes where the hidden content is stat tiles.
- Hiding a section took its **heading** with it, so a reader learned nothing about what the
  platform tracks. Headings and descriptions now stay for everyone; only figures are withheld.
- The workspace drill-in showed an **empty** contributor leaderboard where the server had
  withheld it — "nobody has contributed here" is a false statement to make to someone who
  simply may not see who did.
- Info icons reached 11 of 35 KPI tiles; now attached everywhere a definition applies.

## 2.11 Metric definitions clipped by their own container

`MetricInfo` positioned its panel absolutely inside the tile, and every anchor sits in a
`KpiCard`, which sets `overflow-hidden` for its rounded corners — so **every definition was
clipped to the tile and the affordance did nothing.** Now portalled, anchored to the button's
rect, clamped to the viewport, flipped above when there is no room below, and following scroll
and resize. The usual objection to portals does not apply here: there is no exit animation and
no backdrop, so there is nothing to strand over the app.

## 2.12 Components changed

| Area | What |
|---|---|
| `backend/app/db/repositories/analytics_repo.py` | Platform summary, per-workspace rows, per-workspace detail, insight rules, redactors |
| `backend/app/services/analytics_scope.py` | `can_see` / `can_open` / `shows_people` / `shows_contact` / `shows_operations` |
| `backend/app/services/analytics_cache.py` | Single-flight + TTL + Redis/in-process, schema-versioned keys, `_serve` |
| `backend/app/services/analytics_warmer.py` | Preset-window warmer on the scheduler-owner role |
| `backend/app/services/product_event_gc.py` | 400-day daily retention sweep |
| `backend/app/api/v1/endpoints/analytics.py` | 3 endpoints under `/admin/analytics` |
| `backend/app/api/v1/endpoints/content_insights.py` | `GET /insights/views` |
| `backend/app/db/repositories/product_event_repo.py` | `subject_id` writes and grouped reads |
| `frontend/src/pages/AnalyticsPage.tsx` + `components/analytics/**` | Six tabs, charts, redaction UI, range calendar |
| `frontend/src/components/views/ViewUsageBadge.tsx` | Usage on the view page |
| `frontend/src/lib/domainLabels.ts` | Single source for `reference → Context View` |
| `frontend/src/hooks/useCanvasTraceWalk.ts` | Context View trace instrumentation |

---

# Appendix A · API surface

| Method | Path | Gate |
|---|---|---|
| `GET` | `/api/v1/admin/analytics/summary` | Analytics permission **or** `analyticsPublicEnabled` (redacted) |
| `GET` | `/api/v1/admin/analytics/workspaces` | as above; rows the reader cannot open are locked, not dropped |
| `GET` | `/api/v1/admin/analytics/workspaces/{workspace_id}` | as above **plus** `can_open`; contributors require membership |
| `GET` | `/api/v1/insights/views` | Whoever can read the view — same `readable_views_clause` the catalogue lists with |
| `POST` | `/api/v1/telemetry/events` | Signed in; type must be in `ALLOWED_EVENT_TYPES` (422 otherwise) |

`GET /insights/views` returns **absence, not refusal**, for ids the caller cannot read. A batch
is a mixed bag by nature, and 403-ing a whole gallery because one tile is out of reach would
make the endpoint useless for its main caller. Absence is also what a non-existent id gets, so
this cannot be used to probe for what exists.

**New telemetry event types:** `lineage.trace`, `lineage.trace_empty`, `graph.search`,
`graph.search_miss`, `graph.export`, `version.published`, `ontology.published`. The `_empty` /
`_miss` variants are separate event **types**, not payload flags, so "how often did someone ask
the core question and get nothing back?" stays a `GROUP BY` on the existing
`(event_type, created_at)` index instead of a payload scan.

---

# Appendix B · Configuration

## Permission

`system:analytics:read` — seeded on `super_admin`, `org_admin` and `org_auditor`.

Analytics had been piggybacking on `system:audit:read`, whose own catalogue description is
"read the platform audit log" — so granting someone growth dashboards also handed them every
login and RBAC mutation, and org admins needed an audit grant to see how the company uses their
own platform. Server-side, any of `system:analytics:read`, `system:admin`, `system:org-admin`
or `system:audit:read` grants the full, unredacted section.

## Feature flags — new **Analytics** admin category

| Flag | Type | Default | Effect |
|---|---|---|---|
| `analyticsPrivacyMode` | `strict` / `internal` / `full` | **`internal`** | How much non-privileged readers see. `strict` = counts and trends only, nobody named. `internal` adds leaderboards and who built what. `full` also adds access backlogs, invite acceptance and refresh failures. |
| `analyticsPublicEnabled` | boolean | **off** | Opens the redacted section to every signed-in person. Privileged users are never gated by it. |
| `analyticsWorkspaceVisibility` | boolean | **off** | Lets Analytics *report on* workspaces the reader is not a member of. Grants no access — links still appear only for people who can open the workspace. |
| `analyticsShowEmailAddresses` | boolean | **off** | Adds a colleague's address beside their name, only where the person is attached to something the reader can already open. Never on the platform-wide activity ranking. |

Notes an operator should read before flipping anything:

- **`analyticsPublicEnabled` fails closed.** An unreadable flag means privileged-only. Failing
  open would publish headcount and workspace existence because of a database hiccup, and that
  is not a disclosure you can take back. Its exemption from the ships-ON rule is stated in the
  test that enforces it.
- **`analyticsPrivacyMode` defaults to `internal`** because this platform is mostly deployed
  inside a single company, where colleague names are already in the workspace member lists.
  Publishing per-person activity to all staff is a works-council question in parts of the EU.
- **`analyticsWorkspaceVisibility` widens what Analytics reports beyond what workspace
  permissions allow**, which is a disclosure no RBAC review would surface. The change is
  recorded in `feature_flag_changes`. The narrower alternative — granting `system:org-viewer` —
  widens the whole product consistently and is named in the flag's admin hint.
- **`analyticsShowEmailAddresses` cannot read past the privacy level.** `shows_contact` is
  composed with `shows_people`, so an address never appears beside a name that is itself
  withheld. On the drill-in it additionally requires membership.
- An admin status line tells administrators what everyone **else** currently sees, because
  otherwise the only way to check a disclosure setting is to sign in as somebody else.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `ANALYTICS_WARM_INTERVAL_SECONDS` | `300` | Warmer cadence; documents are written with a TTL of 3× this. Clamped against values aggressive enough to be a load generator. |
| `PRODUCT_EVENT_RETENTION_DAYS` | `400` | Clamped to ≥ 365 so a year-long chart cannot be made to lie. Non-integer values fall back to the default with a warning. |

Both background tasks — the warmer and the retention sweep — run only where `runs_scheduler()`
is true, and both are shut down before DB pool teardown.

---

# Appendix C · Verification

Re-run on this branch at `da3f5ad5` on 2026-08-23:

```
backend  pytest backend/tests/test_api_analytics.py \
                backend/tests/test_content_insights.py \
                backend/tests/test_analytics_warmer.py
         → 102 passed in 17.25s

frontend vitest src/pages/__tests__/AnalyticsPage.test.tsx \
                src/components/analytics \
                src/components/views/__tests__/ViewUsageBadge.test.tsx \
                src/lib/__tests__/domainLabels.test.ts \
                src/hooks/__tests__/useCanvasTraceWalk.test.ts
         → 7 files, 67 passed in 5.73s
```

What those tests are actually holding:

- **Disclosure** — no email survives a public document; locked rows keep their totals;
  operational health disappears; insights are allow-listed in both directions; drill-in is
  refused; the redacted-document and HTTP-body sweeps, and the sweep that must fail on a
  privileged document.
- **Scale** — three readers at three access levels served from one aggregation, in both orders;
  `/insights/views` pinned at three queries whatever the batch size.
- **Correctness** — inclusive range bounds, ghost alignment across a month boundary, the
  `buckets`-missing regression reproduced without its guard, insight ranking and silence, the
  retention floor, each health table.
- **Instrumentation** — the Context View trace tests run against the real walk driver with only
  the provider stubbed, pinning the event at the real settle point: nothing at start, one event
  however many waves the model lands in, its own type on an empty trace, and a second event for
  a second press.

The migration was exercised in both directions and twice over on a real SQLite database,
including a row the backfill cannot attribute — stamped with a sentinel so the `IS NULL`
predicate terminates, and counted as platform usage but never as a view in a ranking.

Every tab was screenshotted in both themes and at each privacy posture, which is how the
centred-`viewBox` geometry, fractional axis ticks on integer counts, clipped end labels and an
invisible distribution bar were found and fixed. The palette validator checks colour, not
layout.

---

# Appendix D · Known limitations & operational notes

- **A custom role granted only `system:analytics:read` sees no nav item.** The nav catalogue
  spec is `["system:admin", "system:org-admin", "system:audit:read"]`, so the client would hide
  the section while the server would serve it. It does not bite the three seeded roles — each
  also holds one of those three — but a hand-built role would need one of them too.
- **A custom range is never warmed.** Presets are precomputed; a custom range pays the
  read-through cost on first request. This is by design: warming an unbounded key space is how
  a warmer becomes a load generator.
- **Numbers are minutes old.** The header says how old, relatively, with the exact instant on
  hover. A stalled warmer degrades to staler numbers, not to an outage.
- **Comparison charts double the axis span.** A 30-day window draws a 60-day axis, so bars are
  half as wide as on a single-period chart. Stated in the subtitle and the in-plot captions.
- **`TimeSeriesChart` still aligns the previous period by bucket index.** A ghost *line* is
  unambiguous as an overlay and shape comparison is what index alignment is for; it is a *bar*
  sitting on a date that invites the reader to trust the axis about it.
- **Workspace distribution bands cover the workspaces this reader is shown**, which for most
  people is a subset. The header says how much of the estate is in view rather than describing
  two of ten as "the estate".
- **`view_visits` still cannot answer "how many opens landed on a Tuesday."** It is an upsert
  keyed `(view, user)` holding each user's *last* visit. Opens are counted from
  `product_events`, which is why usage figures only exist from the release that started
  appending them.

---

# Upgrading

1. **Run the migration.** `20260821_1200_event_subject` adds `product_events.subject_id` and
   `idx_product_events_subject`, then backfills the column in Python — one spelling, because
   SQLite and Postgres extract JSON differently. It is inspector-guarded: `0001_baseline`
   `create_all()`s the current ORM, so a bare `add_column` would make a brand-new environment
   unbuildable while every migrated database kept working.

2. **Nothing turns on by itself.** Analytics is visible to `super_admin`, `org_admin` and
   `org_auditor` on deploy and to nobody else. Opening it to everyone is
   `analyticsPublicEnabled`, and that reader sees the redacted document.

3. **Decide the two disclosure settings deliberately.** `analyticsPrivacyMode` defaults to
   `internal` (colleagues named). `analyticsWorkspaceVisibility` and
   `analyticsShowEmailAddresses` both default off, and turning either on widens what is
   disclosed beyond what workspace permissions currently allow. Both changes are recorded in
   `feature_flag_changes`.

4. **Check `runs_scheduler()` on at least one replica** if you want warmed documents and event
   retention. Neither is required for correctness — the dashboard falls back to read-through,
   and nothing breaks if `product_events` is never swept — but a deployment with no scheduler
   role pays the aggregation on the read path and grows that table without a horizon.

5. **Grant `system:analytics:read` to any custom role that should see the section**, alongside
   one of `system:admin` / `system:org-admin` / `system:audit:read` until the nav catalogue
   spec is widened (see Appendix D).
