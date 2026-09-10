# Changelog

Release history for {brand}. Notable changes, newest first. Dates are release dates.

Sections follow [Keep a Changelog](https://keepachangelog.com): **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed**, **Security**. Anything that requires action on upgrade
is called out under **Upgrading**, and anything we know is still wrong is under **Known
limitations** — a changelog that only lists good news is not worth reading.

---

## [Unreleased] — Analytics, and measuring value rather than attention

### Added

**Admin → Graph store: every node of every graph store, and what lives on it.** On a
nine-node cluster the app showed three. The Infrastructure probe counted masters from the
environment's own topology and the capacity card read only the nodes that owned an aggregated
graph, so every replica was absent — and a node missing from a list is indistinguishable from a
node that does not exist. The new page reads one snapshot of the whole fleet: masters and
replicas with their memory, health, uptime and limits; slot coverage with the missing ranges
named; how memory and graphs are distributed across shards; replication as it actually is
(replicas online, worst lag, full resyncs) with each finding written as a sentence carrying its
fix; and every graph on each shard with the data source that owns it, searchable. Deep links
focus a shard, open a node's limits, or switch to a flat all-nodes view; a "How to read this
page" glossary defines every term on it. A guide (*The Graph Store: Shards, Replicas &
Placement*) is one click away.

**Where a data source lives, on the data source.** Its profile now says which node holds its
graph, which shard and slot, that node's health and memory, its replicas and their lag, and how
many other graphs share the shard — and, in dedicated projection mode, that the rollups have
their own graph key which can land on a different shard. Provider cards say what the connection
actually reaches (mode, master shards, replicas, nodes up, slot coverage) and list every node
when expanded. Job history rows carry a shard chip, from one batched call per page.

**A rebuild never writes faster than its replicas can absorb.** After every rollup batch the
pipeline asks the master how many replicas have acknowledged it. Acknowledged, and the wait
joins the write's latency so a replica-bound shard paces itself like a slow master; not
acknowledged, and the run holds — heartbeating, re-reading replication state, retrying — until
they catch up, releasable live by setting replica acknowledgement to 0. This exists because
FalkorDB replicates a write below its effects threshold by RE-RUNNING the query on every
replica, on the replica's main thread and with no timeout: a large rebuild could drive replicas
past their health probes, get them restarted, and take the shard with them. The run also warns
at the start when a master has replicas and an effects threshold above 0, which is the setting
that decides this.

**Read-only queries are served by a shard's in-sync replicas.** The master took every write
AND answered every read, so on a cluster with two replicas per shard two thirds of the hardware
sat idle while one master's query threads were the bottleneck for everyone opening a canvas.
Reads are now offered to a replica under four gates, any of which sends the query to the master
instead: the provider allows it (*Read queries* in its connection settings, default on), the
replica is online and within the lag threshold, this process has not written to that graph
recently, and the replica has not just failed a read. A rebuild reads only from the master for
its whole run, because it reads back what it has just written. A replica that errors sends the
same read to the master once.

**A node restarting is a pause, not an outage.** A refused connection inside a rebuild is now a
wait: the run heartbeats, re-resolves the owner (finding the promoted replica), and retries the
same work at the same width from the same checkpoint, for up to fifteen minutes. If it does give
up, the failure names the node, how long it waited, and what to check — where the circuit
breaker's "Circuit open; will probe downstream again in ~28s" used to overwrite it. For readers,
a node being replaced is its own signal that never opens the breaker: reads fail fast with a
three-second retry hint, the canvas keeps its last answer behind a *Reconnecting to the graph
store* line and retries itself, and the node's restart is recorded as evidence on the run.

**Rebuilds that always complete under the graph store's per-query limits.** A rebuild that
meets the store's per-query memory ceiling (`QUERY_MEM_CAPACITY`) or a per-query timeout no
longer fails — it goes slower until every query fits: the first refusal of a run drops read
concurrency to 1; the reconcile scan (the pipeline's widest projection) switches to a keys-only
two-pass strategy; scans halve down to a scan floor that now defaults to **one row**, re-growing
after sustained successes and never straight back into a width that failed; write and delete
batches halve the same way; a narrowest scan that keeps timing out is retried with backoff and
heartbeats before the run reports the store as unreachable and keeps its checkpoint. The only
terminal outcome is a single row larger than the ceiling, and its message names the scan, the
row and the ceiling. What a rebuild learned is remembered per source and seeds the next rebuild
of that source (never wider than its settings; *Ignore last run* opts out).

**Every run shows what it ran with, and what it adapted to.** Job History's stat grid gains a
*Settings* cell — the profile the run matches, or *Custom* — with a *Run settings* disclosure:
every knob with where its value came from (*Job override*, *Fleet default*, *Learned from last
run*, *Environment*), including the stall window and wall clock, and plain sentences for what
the pressure ladder changed; written at the first checkpoint, so a failed or cancelled run has
it too, and read from the live stream while a job runs. A running row shows an amber *Going
slower to fit the graph store* state; the Freshness badge reads *narrowing*.

**Every time limit is a knob.** *Time limits* in the Defaults dialog and Advanced tuning: scan
timeout and write timeout per query (the graph store's own `TIMEOUT_MAX` caps them, and the
editors say so), the stall window as a fleet default that machine-queued rebuilds now honour,
and the wall clock (never below the stall window). Bounds lifted to seven days. Plus a **Gentle**
profile in the re-trigger dialog — narrow scans, serial reads, generous pacing, a longer scan
timeout — pre-selected, with the reason, after a per-query memory or timeout failure; the canvas
banner offers the same retry. The capacity card shows each node's per-query limit.

**More time for a job that is still going — one, or all of them.** A pending or running job's
stall window, wall clock and per-query timeouts can be raised without cancelling it:
`PATCH /admin/data-sources/{id}/aggregation-jobs/{job}/limits` (the same gate as cancel and
resume; the actor is always the authenticated user), an *Adjust this run* control in the
running row — what the job is running under, what is left of it, one-click +1/+3/+6/+12 h,
a wall-clock doubling, the per-query budgets, and who raised what — an *Extend all by +3 h*
strip when several jobs are running, and *Give it more time* on the canvas banner. The worker
re-reads the row every thirty seconds through a fresh session; per-query budgets apply to the
next query. The history lives on the job row, shown in Job History.

**Go gentler on a job that is still going.** The same `PATCH …/limits` now takes the scan shape:
a pacing ratio (from the next write; 0 = no pacing), a cap on read concurrency (from the next
wave) and a cap on the scan width (from the next scan — a ceiling the pressure ladder may still
narrow below on its own), plus `reset` to clear live values back to the job's settings. The
worker's watchdog re-reads them with the time limits every thirty seconds — a failed read changes
nothing, and an absent key clears — and the pipeline reads them per write, wave and scan. *Adjust
this run* in Job History gains a **Go gentler** group — the shape in force, *Pace ×2*, *Pace ×4*,
*Serial reads*, *Halve scans*, *Back to settings* — and the run's record and the live row show
*Changed while running*.

**The canvas narrows its reads instead of dropping them.** The aggregated-edge read — the
canvas's rollup reads, on-demand pair synthesis and the raw mirror — gets the same treatment as
a rebuild's scans under the store's per-query limits: a refused page is halved and re-read from
the same keyset position down to a floor (`AGGREGATED_EDGE_PAGE_FLOOR`, 500 rows), a refused URN
batch is split in halves down to a single URN, a floor-width timeout is retried once, briefly. A
read that completes after narrowing is a complete answer. What is still refused at the narrowest
page or batch is lost and SAID: `staleReason` `query_memory` or `timeout`, with a `degradedDetail`
(kind, how far it narrowed, the node and its ceiling) on the result, the canvas bootstrap and
expand freshness; the canvas shows *The graph store refused part of this read at its per-query
memory limit — showing what it could read after narrowing* with the way to the node's limits for
a system administrator, in place of the generic truncation advice, and never asks the projector
about it. One pressure classifier now serves both ladders.

**The rebuild worker flushes on real memory pressure.** The pipeline samples the worker's RSS
against its cgroup memory limit (at most once a second, from the merge loops) and flushes its
accumulator early — the same exact-weight flush the pair cap triggers — when RSS crosses
`AGGREGATION_FLUSH_MEM_PCT` (60%) of the limit with at least `AGGREGATION_FLUSH_MIN_PAIRS`
pending; the extract phase's base map rolls up early under the same pressure. Fail-open when
either reading is unknown (the pair cap still bounds memory). *Memory flush* is a fleet knob in
the Defaults dialog; a run that flushed on memory says so in its record and on the live row
(*Flushed 3× on worker memory (peak 2.9 GB of 4.0 GB)*). The readers moved to
`providers/process_memory.py` (`MemoryGauge`); the fleet's claim deferral shares them.

**Two rebuilds cannot both pass on the same headroom.** A rebuild that passes a budget check
now enters what it still has to write in its node's reservation ledger (on the job-bus Redis,
beside the write lease), and every other rebuild's budget takes that off the node's free
memory as if it were already in use — the whole growth before the apply, one wave for an
overflow flush, the remainder at each mid-apply recheck, released with the lease. The
capacity card, a source's Capacity block, Infrastructure's memory headroom and the Defaults
dialog's what-if all show *held by N running rebuilds* and subtract it; a refusal names it. The
ledger fails open like the rest of admission: without the bus, the node is measured alone.

**Auto's cube ceiling and the estimate margin are fleet knobs.** Both sit in the Defaults
dialog's Capacity group, resolved like every other knob (stored Defaults over the environment,
clamped to the pipeline's bounds, labelled by source in the capacity API) and recorded in every
run's settings. The run warns when the cube ceiling sits above an explicit edge ceiling. Only
the apply's re-measure interval remains the deployment's.

**The graph store's own limits, from the UI.** `TIMEOUT_MAX` and `QUERY_MEM_CAPACITY` no longer
live only in the deployment. Infrastructure → Memory headroom shows each node's per-query memory
ceiling, query time cap and thread count (read with the capacity sweep), and system administrators
get *Adjust graph store limits*: the node is read fresh; the change is checked — a cap never below
the node's `TIMEOUT_DEFAULT`, raising the ceiling needs the container memory limit and is refused
with the shortfall when the deployment guide's sizing formula says the container cannot back it,
`0` refused, lowering needs nothing; set with `GRAPH.CONFIG SET` on the node or every primary; read
back, verified, and logged with the actor (`PATCH /admin/graph-store/{endpoint}/limits`). The
dialog hands over the `FALKORDB_ARGS` fragment that makes a runtime change permanent. The
application now clamps per-query timeouts to the cap it reads from each node — the write budget
and the capacity sweep teach every provider — with `FALKORDB_SERVER_TIMEOUT_MAX_MS` as the
fallback until a node has been read (the socket timeout is floored above the knobs' maximum), so
a raised cap reaches the next query without a restart; the editors' timeout notes show the cap
read from the store; a failed source's guidance and the Gentle pre-selection link straight to the
node's limits. `FALKORDB_CONTAINER_MEMORY_BYTES` (optional) prefills the container field;
`AGGREGATION_SLOT_STALE_SECS` defaults to 660 so a write allowed a raised cap keeps its slot.

**Rollup capacity you can see, and every limit you can set.** Ingestion → Freshness gains a
*Graph store capacity* card: one row per shard with a meter of memory in use, the fleet reserve
marked on it, what is free after that reserve, how many more rollup edges that is, and the
sources whose rollups live there — each a way into its drawer. A shard the budget cannot govern
says why and which rule applies instead; a *would not fit* count filters the table to the
sources whose last rebuild was refused. A source's drawer gains a *Capacity* block (footprint,
shard headroom, last decision, and a pre-flight for Full detail versus Auto) and a per-source
**Rollup storage** control in ③ Act — the control the "would not fit" guidance always named —
settable before a large source's first build and honoured by automation and manual rebuilds
alike. The re-trigger dialog answers whether *this* run would fit before it is queued,
re-deciding as the form changes. Behind all of it: `GET /admin/aggregation/capacity` and
`GET /admin/data-sources/{id}/capacity`, the write budget's own reading and arithmetic
assembled for people, one `INFO` per shard, under a deadline, never raising.

**A Defaults dialog on the house shell.** Every tuning knob in one place, grouped (Capacity,
Reading, Writing, Rollup storage), each value labelled *Set here* or *Environment default*
from the server's live env defaults (`envTuningDefaults` on the settings GET, so the editors'
placeholders can no longer drift from the deployment), a Reset that sends the explicit null the
merging server needs, a dirty guard, and a live what-if: as the reserve or bytes per edge is
edited, the dialog restates how many more rollup edges each measured shard would take, before
Save. Reachable from the workspace dashboard and from the capacity card.

**The apply re-measures the shard.** Every `AGGREGATION_BUDGET_RECHECK_EDGES` (1,000,000)
first-touch edges written, a rebuild re-reads the shard that owns its graph and refuses, with
the numbers, when the remainder would not fit — after the chunk's checkpoint, so it can be
resumed from its cursor once memory is freed, and never as the write that fills a shard shared
with another graph. `run_stats.budget_rechecks` says it happened.

**An operator guide, in the app.** *Rollup Capacity & Large Graphs* under For Administrators,
linked from every new control; the automatic-reconciliation and external-change-notification
feature docs are registered in the docs viewer for the first time, so the ordered "graph too
big" runbook is finally reachable from the product.

**A top-level Analytics section at `/analytics`.** Six tabs — Overview, Growth,
Engagement, Content, Health, Workspaces — under one range control (7d/14d/30d/90d/6m/1y
or any custom range) that every chart, figure and table on the page re-renders against,
so the numbers always agree with each other. Every number carries a definition saying
what it counts, how it is computed, and what to do if it moves.

**The product's own value moments are now instrumented.** Seven new product events —
`lineage.trace`, `lineage.trace_empty`, `graph.search`, `graph.search_miss`,
`graph.export`, `version.published`, `ontology.published`. The `_empty`/`_miss` variants
are separate event *types*, not payload flags, so "how often did someone ask the core
question and get nothing back?" stays a `GROUP BY` on an existing index rather than a
payload scan. Activation is now scored on tracing lineage rather than on creating a
view: authoring is a later, heavier commitment, and scoring activation on it measured
investment rather than value.

**Usage figures on the content itself.** The view page now shows opens, distinct viewers
and a trend beside the view's name. `GET /insights/views` is deliberately not under
`/admin` and not analytics-gated — it returns counts and dates with no identities, scoped
by the same `readable_views_clause` the catalogue lists with, in three queries whatever
the batch size. Ids the caller cannot read come back absent rather than refused, which is
also what a non-existent id gets.

**Server-computed narrative insights** above the Overview charts, ranked by significance.
Every rule is a pure function of the finished summary document — so an insight can never
contradict the chart beneath it — and every rule is guarded, so a young install gets
silence rather than five findings manufactured from three users.

**A first-run panel** on new deployments, in place of six empty charts and four zero
tiles, linking the steps that fix it and gating each on whether this reader can take it.

**A custom range calendar** — two months side by side, Monday-first, UTC, with named
periods (this/last month, this/last quarter) and full keyboard navigation, replacing two
`<input type="date">` boxes that could not show the shape of a range.

**A visual harness** — `npm run harness:analytics` — rendering the real components against
one fixture per privacy posture. The postures cannot be checked by hand: seeing the strict
view needs a second account with no workspace bindings and two flags set a particular way.

**`system:analytics:read`**, seeded on `super_admin`, `org_admin` and `org_auditor`.
Analytics had been piggybacking on `system:audit:read` — "read the platform audit log" —
so growth dashboards came bundled with every login and RBAC mutation.

**Four feature flags in a new Analytics category:** `analyticsPrivacyMode` (strict /
internal / full, default `internal`), `analyticsPublicEnabled` (off), `analyticsWorkspaceVisibility`
(off), `analyticsShowEmailAddresses` (off). See **Upgrading**.

**Retention for `product_events`.** A daily sweep on the scheduler-owner role keeps 400
days (`PRODUCT_EVENT_RETENTION_DAYS`, clamped to ≥ 365 so a year-long chart cannot be made
to lie). The table had no horizon because its contents used to be rare; it now takes a row
per view open, lineage trace and graph search.

### Changed

**The capacity view is built on one reading of the whole graph store**, so it stopped
churning. It used to resolve a provider per source and ask it who owned each graph, which meant
a node appeared only if some source's provider could be built and dialled inside a deadline,
every failure was cached wholesale, and rows re-sorted by live utilisation. Placement is now
arithmetic over the topology snapshot: every master is a row whether or not anything sits on it,
a node that could not be read is a row with the reason, "cannot govern" is told apart from
"unreachable", the order never moves, and a failed refresh keeps the figures on screen with a
note instead of blanking the card. `AGGREGATION_CAPACITY_DEADLINE_S` is gone with the sweep, and
both capacity routes are served in-process in every mode.

**A graph store node's limits are adjusted from Admin → Graph store**, which is where the node
is looked at. Any node can be targeted — including one holding no rollups yet, and every node of
an instance at once, so a promoted replica already carries the change. The Infrastructure page
still answers its old `?limits=` deep link. The dialog gains the **effects threshold**, the
setting that decides whether replicas apply a change log or re-run every write.

**The container sizing rule now counts replication, and the production manifests are sized by
it.** The rule had three terms — dataset, query memory, overhead — and the replication buffers
were charged to the same container without appearing in it. Raising those buffers (below) is a
memory decision, and the pairing that looked right without them (32 GiB with a 1.5 GiB per-query
ceiling, 52.7 GiB) needs **57.7 GiB** with them, over the 56 GiB limit. The shipped values are
now 32 GiB and a 1 GiB ceiling: **53.8 GiB**, with the whole table in the manifest comment and
the guide. For scale, the pairing before any of this (40 GiB and 2 GiB) needed 66.6 GiB, so a
shard under load could be OOM-killed while every figure inside Redis looked healthy. Note the
in-app *Adjust limits* guard computes dataset + query memory + overhead only: on a master with
replicas, subtract the replication terms from the container figure you give it. Also: `EFFECTS_THRESHOLD 0` and `OMP_THREAD_COUNT 1` on every
FalkorDB deployment, a 1 GB replication backlog and 2 GB replica output buffers (256 MB overflows
in seconds under a rebuild and forces a full resync), `repl-timeout 300`,
`cluster-node-timeout 15000`, and a liveness probe that allows 10s × 6 rather than 3s × 3 — a
node busy applying replication is not a dead process. **Check what each shard currently holds
before applying the `maxmemory` change.**

**Memory headroom on the Infrastructure page shows every measurable node, always**, with
the rollup reserve marked and what still fits at the fleet bytes-per-edge. It used to appear
only once a node was 85% full — after the one number that decides whether a rebuild fits had
already stopped mattering.

**The per-job Advanced tuning form and the fleet Defaults share one knob catalogue.** A knob is
described once; an empty per-job field says which value it inherits and from where. The
onboarding wizard's tuning step now shows the Rollup storage the fleet actually resolves instead
of assuming Full detail.

**The aggregation write budget measures the graph store instead of counting to a
number.** "Writing this would risk exhausting the FalkorDB instance's memory" was a static
edge cap (25M, hard-bounded at 50M) that never read the instance, so adding memory to every
shard changed nothing — and every UI preset pinned that cap onto the job. A rebuild now reads
`INFO memory` on the one shard that owns the graph before it writes, allows the write while
the *new* edges fit under a reserve (`AGGREGATION_SHARD_RESERVE_PCT`, 20%), and refuses with
the whole record — the shard, the edges and bytes needed, what was free of what `maxmemory`,
the shortfall, what governed, and the ways out — as a new *Would not fit* failure category
with its own guidance. Forced Full detail is checked on the up-front estimate, so a cube that
cannot fit is refused with nothing computed and nothing written; the exact count is re-checked
after compute and before every overflow wave. Bytes-per-edge is calibrated per graph from each
fresh rebuild's own before/after usage (recorded on the source's state row) and a planning
figure (512 B) until then. Operators set the limits in Defaults or per job: *Shard memory
reserve*, *Bytes per rollup edge*, and an optional *Edge ceiling* (`maxMaterializedEdges`, bound
lifted to 500M) layered over the measurement. Where the shard cannot be measured — no
`maxmemory`, or the read failed — the static cap governs as before, and the message says so.
`run_stats.write_budget` records the decision on every successful run.

**Analytics now follows the app's permission model instead of re-deciding it.** It was
*stricter* than the product it reports on in four places — ignoring `system:org-viewer`,
hiding `enterprise`-visibility view names, denying a creator reach to their own work, and
withholding email addresses that `GET /views/{id}` has always returned. Being over-cautious
is not the harmless direction to be wrong in: a dashboard that hides what the rest of the
app shows teaches people its numbers are unreliable.

**Analytics documents are cached once per window and redacted per reader.** The cache key
was a fingerprint of the caller's visible workspaces, so readers with different access never
shared an entry — a few hundred concurrent users meant a few hundred full recomputations per
TTL, and the cache worked hardest exactly when it needed to help most. The audience was in the
key because the *redacted* document was in the value; the unredacted one is now cached and
`_serve` is the only way anything leaves it, deep-copying before applying a redactor.

**The standard windows are precomputed off the read path.** A warmer on the scheduler-owner
role recomputes the six presets every 300 s (`ANALYTICS_WARM_INTERVAL_SECONDS`) with a TTL
three passes long. Purely an optimisation — a cold key, a custom range, a drill-in, or a
deployment with no scheduler role still works through read-through. Documents are minutes old
by design, so the header says so relatively with the exact instant on hover.

**Event counts are grouped in SQL instead of decoded in Python.** `product_events.subject_id`
denormalises what an event is *about* out of its JSON payload, indexed
`(event_type, subject_id, created_at)`. Measured on 200k opens across 2,000 views over 90
days: the full-window fold 1345 ms → 401 ms, and one view's usage 1345 ms → 2.4 ms. The
second number is what makes usage-on-the-content affordable at all.

**Comparison charts place both periods on one continuous time axis**, every bar on the date
it happened, with a dashed divider, a wash over the earlier half and in-plot captions naming
each. The previous period is a paired column that differs by texture (hatched), fill (outlined)
and tint — not opacity alone, which reads as "disabled" rather than "earlier" — and the
tooltip names the delta with an arrow, never a colour, since the chart does not know whether up
is good. The cost is stated rather than hidden: a 30-day window draws a 60-day axis.
`TimeSeriesChart` deliberately keeps index alignment; a ghost *line* is unambiguous as an
overlay, and it is a *bar* sitting on a date that invites the reader to trust the axis about it.

**Withheld content is locked and explained rather than removed.** A synthetic silhouette in
the real geometry, the heading and description kept for everyone, and a locked workspace row
that offers to request access — asking first, saying what is being requested and who will see
it, and taking a note. Frosted glass over the real thing was rejected as a security bug: CSS
blur is a paint effect and every value stays one view-source away.

**`reference` renders as "Context View" everywhere.** The mapping had been hand-written in
four places and Analytics was the fifth surface, rendering the raw enum; `lib/domainLabels.ts`
is now the single source. **"Active users"** is one name for one measure across Overview, the
drill-in, the KPI tile and the Engagement chart.

**The Workspaces tab opens with what the estate is made of** — existing vs visible, quiet,
unconnected, and two ordered distributions — rather than with a sortable table, which only
answers a question nobody arrives with. Locked rows collapse behind a summary; they still
exist, because the table has to keep agreeing with the totals above it.

**The default Overview window is 14 days** rather than 30 — long enough that a quiet Tuesday
does not swing the trend, short enough that "what changed" is still about now.

### Fixed

- **A slow scan escaped the pressure ladder and restarted the run.** Every query goes out with
  a server `TIMEOUT` 500 ms under the client budget, so a slow scan is aborted by the store and
  arrives as its own *Query timed out* error — which the ladder, listening for the client
  deadline only, never saw. Both signals now enter the ladder.
- A rebuild that gave up after its own timeout retries was reported as *Job killed by
  watchdog*; it now says which scan timed out, at what width and budget, and that the job
  resumes from its checkpoint.
- Job History's error hint for a per-query memory failure told operators to lower the scan
  range width, which the rebuild already does by itself.

**The Growth tab crashed against any server that had not deployed yet** —
`series.previous.buckets is not iterable`, an unguarded spread of a field the running backend
did not send. Analytics documents are precomputed into Redis and outlive the code that wrote
them, so *every* future field carries this hazard: the cache key now carries a schema version,
`comparedSeries` returns null unless the previous period has a date for every value, and the
shared chart primitive checks rather than throwing.

**Metric definitions never appeared.** `MetricInfo` positioned its panel absolutely inside the
tile, and every anchor sits in a `KpiCard` with `overflow-hidden` — so every definition was
clipped to its tile and the affordance did nothing. Now portalled, viewport-clamped, flipped
when there is no room, and following scroll and resize.

**A previous-period tick was drawn at every bucket, including zeros**, landing on the axis
where consecutive ones merged into a rule that read as a plotted series — a sparse window
looked like a field of floating dashes with one real bar among them. A chart also no longer
calls itself empty when only the *current* window is flat.

**The `views-not-opened` insight was invisible to everyone it was for.** `redact_summary`
fails closed, which is right, but silently — an unclassified rule is simply dropped, no error,
no red test. A test now cross-checks every key any rule can emit against all three allow-lists
in both directions, scanning the source rather than running the rules.

Plus: an all-zero trend no longer draws a sparkline (a flat rule with an end dot reads as
"steady at some level"); the sorted-column meter no longer shades a whole row; future days in
the calendar no longer render louder than pickable ones (an alpha modifier on a bare `var()`
token compiles to a colour the browser drops); a `useId` pattern id no longer begins with a
colon, which an XML name may not and a browser may refuse to dereference.

### Security

**A redacted document was still shipping user ids.** `createdBy` was added to popular-view
rows so the redactor could honour a creator's reach to their own work, and both branches of
`_redact_view_row` then spread `**row` — so every redacted view carried its author's user id
to a reader who could not see the view's name. Rows are now projected through an explicit
allow-list: a column added to a ranking query is withheld until someone names it on purpose.

**The workspace drill-in leaked its contributor roster.** `workspace_detail` returned its
document unfiltered, guarded only by `can_see` — *may Analytics report on this workspace* —
which is an access decision, not a decision about what a document may contain. It shipped
`topContributors` with names and email addresses at every privacy level, including the strict
one whose entire premise is that no individual is ever named, and
`analyticsWorkspaceVisibility` made that reachable for non-members. Fixed with a single exit
through `redact_workspace_detail`, contributors gated on `can_open` plus membership.

**Guards that fail loudly.** A sweep over the serialised redacted document, a second over the
HTTP response body (the repo's return value is not what reaches a browser), a router-walking
sweep that enumerates the mounted routes rather than a list someone must remember to update,
and a fourth that requires the identifiers to be *present* in a privileged document — a guard
that cannot fail proves nothing.

### Upgrading

- Migrations `20260909_1000_observed_tuning` (`data_source_state.observed_tuning`, what the
  last rebuild of a source learned under pressure) and `20260909_1100_job_live_overrides`
  (`aggregation_jobs.live_overrides`, limits raised on a running job); both mirrored in
  `init_aggregation_db`, so a control plane that boots first is fine.
- `AGGREGATION_SCAN_SHRINK_FLOOR` now defaults to 1 (was 10,000): a rebuild narrows all the way
  to one row before it concludes. Set the *Scan floor* knob to restore an early stop.
- The stall window and wall clock accept up to seven days; `timeoutSecs` above 86,400 is no
  longer rejected.

**Run the migration.** `20260908_1000_rollup_storage` adds the nullable
`aggregation.data_source_state.rollup_storage` column (inspector-guarded; the Control Plane's
start-up init adds it too, so a Control Plane that boots before the migration is fine).

**Set `maxmemory` where you want capacity measured.** The capacity card, the drawer block and
the fit check read the same `INFO memory` pair the write budget does; a node without a
`maxmemory` shows as *cannot be measured* with the static cap that governs it.

**Presets no longer pin `maxMaterializedEdges`, and a stored one now overrides the shard.**
An explicit ceiling on a job wins over the measured budget — that is what it is for — so a
25M value left in Ingestion → Freshness → Defaults from an earlier preset will keep every
rebuild at 25M however much memory the shards have. Clear that field (empty = the shard
governs) unless you mean it; the refusal names the ceiling when one governed. Jobs re-triggered
from Job History seed from Defaults, so they pick the change up at once.

**Set `maxmemory` where you want the budget measured.** Every top-level deployment already
passes it; the `deploy/topologies/docker-compose.falkordb-*.yml` files do not, and run on the
static edge cap until they do.

**Run the migration.** `20260907_1000_bytes_per_edge` adds the nullable
`aggregation.data_source_state.observed_bytes_per_edge` column (inspector-guarded; the
Control Plane's start-up init adds it too, so a Control Plane that boots before the migration
is fine).

**Run the migration.** `20260821_1200_event_subject` adds `product_events.subject_id` and its
index, then backfills in Python — SQLite and Postgres spell JSON extraction differently. It is
inspector-guarded, because `0001_baseline` `create_all()`s the current ORM and a bare
`add_column` would make a brand-new environment unbuildable while every migrated database kept
working.

**Nothing turns on by itself.** Analytics is visible to `super_admin`, `org_admin` and
`org_auditor` on deploy and to nobody else.

**Two settings widen disclosure — decide them deliberately.** `analyticsWorkspaceVisibility`
lets Analytics *report on* workspaces RBAC hides from a reader (reporting only; it grants no
access and renders no link they cannot follow). `analyticsShowEmailAddresses` adds addresses
beside colleagues attached to something the reader can already open, never on the
platform-wide activity ranking, and cannot read past `analyticsPrivacyMode`. Both default off
and both changes are recorded in `feature_flag_changes`. `analyticsPublicEnabled` fails closed:
an unreadable flag means privileged-only, because failing open would publish headcount and
workspace existence over a database hiccup.

**Run the scheduler role somewhere** if you want warmed documents and event retention. Neither
is required for correctness, but without it readers pay the aggregation on the read path and
`product_events` grows with no horizon.

### Known limitations

- A single row larger than the graph store's per-query memory ceiling is still terminal for that
  rebuild — the message names which, and the ceiling is now adjustable from Infrastructure. A
  runtime change to the store's limits lasts until the store restarts (the dialog hands over the
  `FALKORDB_ARGS` fragment); the container-memory guard trusts the figure entered or
  `FALKORDB_CONTAINER_MEMORY_BYTES`, since the application cannot read the container limit;
  `THREAD_COUNT`, `OMP_THREAD_COUNT` and `CACHE_SIZE` remain load-time only.
- The scan floor, the chunk sizes and rollup storage change on the next Resume or Re-trigger,
  not on a running job; the time limits, pacing, read concurrency and the scan width are live.
- The read-side ladder covers the aggregated-edges family; trace drills, children and
  top-level pages keep their current behaviour under the store's per-query limits.
- The memory-aware flush reads the worker's cgroup limit; on a host without one only the
  pair cap (`AGGREGATION_MAX_PENDING_PAIRS`) bounds worker memory, as before.
- The status probe and the topology reading can name the same node differently under an address
  remap (the probe reads the env topology, the reading dials each node from the provider's own
  settings); the Infrastructure page unions the two by endpoint rather than joining them, and
  Admin → Graph store shows the announced address beside the dialled one when they differ.
- Replication backpressure protects the replicas of the shard a run writes to. A replica that is
  detached (the master reports none attached) is not waited for — it is flagged on the Graph
  store page instead.
- A node restart is detected from its run id and uptime when it answers again. Why it restarted
  comes from the orchestrator, which the application cannot read; the guide gives the command.
- Per-graph sizes are sampled and refreshed with the topology reading, not live, and are capped
  per node so one snapshot cannot become a load generator.
- Replica reads are eventually consistent within the lag threshold and the settle window. A
  provider whose readers cannot accept that can be pinned to master-only reads. The window
  covers this process's own writes; a write from ANOTHER pod is only bounded by the lag
  threshold.
- The Full-detail pre-flight is *unknown* until a source has one successful rebuild: the cube
  estimate it needs is recorded on success only.
- A custom role granted **only** `system:analytics:read` gets no nav item: the catalogue spec
  is `["system:admin", "system:org-admin", "system:audit:read"]`, so the client hides what the
  server would serve. The three seeded roles each also hold one of those, so this does not bite
  them.
- Custom ranges are never warmed and pay the read-through cost on first request. Warming an
  unbounded key space is how a warmer becomes a load generator.
- Usage history starts from this release — opens are counted from `product_events`, and
  `view_visits` is an upsert keyed `(view, user)` that only ever held each user's *last* visit.
- Workspace distribution bands cover the workspaces this reader is shown, which for most people
  is a subset; the header says how much of the estate is in view rather than calling two of ten
  "the estate".

---

## [Unreleased] — View sharing that means what it says

### Changed

**Rollups are stored in full detail by default.** Every ancestor-pair
combination is now pre-created — leaf-involving and mixed-level included — so
no canvas granularity can come back thin. This closes a real gap on
self-nesting ontology types (`Node ⊃ Node ⊃ Node`), where the boundary mode's
on-demand reader still reasons in ontology type levels and could return
incomplete mixed-granularity drill answers. The previous default, `auto`,
stored the full cube only while it fit the cube ceiling and fell back to the
depth-diagonal above it.

It applies everywhere without new plumbing, because every automatic rebuild
already resolves its configuration server-side: reconciliation drift and first
builds, the cron drift sweep, the stale-marker reconciler, Refresh rollups, the
projector heal hook, and the Ingestion re-trigger dialog.

**Rollup storage is now a fleet-wide setting an operator owns.** Ingestion →
Freshness → Automation → ③ Act → Advanced switches the whole fleet between
Auto and Always full detail, and every subsequent run picks it up. The
workspace Defaults dialog gained the same control in place of its
"Materialize fine pairs" checkbox.

**Machine-queued rebuilds get the same stall window as a hand-started one.**
`AGGREGATION_STALL_TIMEOUT_SECS` moves 900 → 10800 (3h), matching what every UI
trigger path already sent explicitly. Only the machine paths leave a job's
`timeout_secs` NULL, so they were the only rebuilds being killed for making no
progress for fifteen minutes — on exactly the graphs large enough to do that,
with nobody watching. A progressing job was never affected; this is a
no-forward-progress window, not a runtime cap.

### Fixed

**"Auto" could not turn full detail back off.** Rollup storage had three
meanings but only two wire values: "Auto" was expressed by omitting the field,
and an omitted field means *inherit*. So once a global default of full detail
was stored, the trigger dialog showed "Auto (recommended)" while the job it
queued ran the full cube. `materializeFinePairs` now accepts `"auto"` as a
value, and the dialog resolves an absent field against the default the server
reports rather than assuming Auto.

**Saving one aggregation default no longer erases the others.**
`aggregation_settings.tuning_json` has two editors now, and it was written by
replacement — so whichever saved last wiped the other's fields. It is merged,
like `cadence_json` already was; clearing a value means sending it explicitly
as `null`.

**Picking a performance profile no longer discards the rollup-storage
choice**, and a profile again reads as active once one is set.

### Upgrading

**Rollup storage changes behaviour on upgrade.** A graph whose full cube
exceeds `AGGREGATION_MAX_MATERIALIZED_EDGES` (default 25M, ~12.5GB at ~0.5KB
per edge, sized against ONE shard) now fails its rebuild terminally on
`MaterializationBudgetExceeded` where `auto` would have degraded to the
depth-diagonal and served finer granularities on demand. A forced cube skips
the up-front estimate, so that failure lands part-way through and leaves a
partial cube until the next successful rebuild reconciles it; reconciliation's
breaker suspends a source after three such passes.

Check your largest graph against the budget before upgrading. To keep the old
behaviour fleet-wide, set Rollup storage to **Auto** in Ingestion → Freshness →
Automation (③ Act → Advanced), or set
`AGGREGATION_MATERIALIZE_FINE_PAIRS=auto`. Note that a value stored from the UI
beats the environment variable.

Deployments pinning `AGGREGATION_STALL_TIMEOUT_SECS` should raise it to 10800
to pick up the watchdog change (`deploy/k8s/base/configmaps/worker-config.yaml`
is updated); keep it below `2 × AGGREGATION_JOB_TIMEOUT_SECS` so the control
plane's stale-job backstop stays the backstop.

### Security

**Private views were not private.** The view-access evaluator checked
workspace membership before the visibility tier, so every workspace member —
and every org-level reader — could open any private view in their workspaces.
Worse, `GET /views/facets` had no authentication at all and served every
private view's tags and creator identity to the open internet-facing API, the
popular list leaked workspace-tier views across workspaces, and the stats
endpoint counted views the caller could not read. Visibility now gates first
(private = creator + explicit grantees + workspace admins), every list and
aggregate read filters inside SQL, and the unauthenticated endpoints require
sign-in.

**Sharing state had side doors.** The generic view-update endpoint accepted a
`visibility` field under mere edit rights, and creating a view straight as
`enterprise` skipped visibility authorization entirely. Both are closed: the
dedicated visibility endpoint is the only path, and it now demands the new
`workspace:view:publish` permission for any transition to or from
`enterprise`. Favouriting no longer works on views you cannot read, and two
graph mutations that had shipped under the read gate
(`vocab-alignment/confirm` and the atomic draft-commit path) require
`workspace:datasource:manage` like every sibling write. A request naming a
`dataSourceId` outside the path workspace now 404s — the binding was never
verified before.

### Added

**Enterprise visibility now actually opens.** Any signed-in user can open a
published view from its `/views/{id}` link and the canvas loads, read-only —
expand, trace, and search included. The data plane accepts a view-capability
context (`?viewId=`) pinned to the view's resolved data source; mutations stay
membership-gated. The single-view read returns a per-caller `access` envelope
(capabilities + `dataAccess`) plus the resolved data source and provider so
the canvas can boot without workspace membership.

**Sharing with people and groups is complete.** A signed-in-user directory
(`GET /directory`) replaces the admin-only picker source, grant roles can be
edited in place (`PUT /views/{id}/grants/{grant_id}`), and the Explorer's
"Shared with me" is a real server-side category (explicit grants, not a
visibility approximation).

**Publishing is a journey, not a wall.** A member who can't publish can ask:
the Enterprise option opens a request (with an optional note) that a
publish-permission holder approves or declines with a reason, both recorded on
the view's timeline. Workspaces that prefer no ceremony set their publication
policy to *open*, where anyone who may change a view's visibility may publish
it directly.

### Fixed

**Views stopped claiming their sources were deleted.** View health was
computed in the browser against the workspace list, which only contains
workspaces you belong to — so every view you could see but weren't a member of
(anything shared, published, or seen as an admin) was branded "Source deleted".
Health is a server fact now, from the same predicate the "needs attention"
filter uses, so the badge and the filter can't disagree.

**Layer assignment stopped being denied to people allowed to read.**
`assignments/compute` is a cached read, but it required *manage* — which
silently 403'd every read-only workspace member's canvas, and every visitor to
a shared view. It is gated as the read it is.

**Access-denied messages say something useful.** Inside a view shared with
you, the card now explains that you're exploring read-only and offers to
request edit access, instead of reciting `Missing permission:
workspace:datasource:read`.

### Security

**Break-glass admin access is visible to the owner.** A platform admin opening
someone else's private view records an `admin_viewed` entry on that view's
timeline (deduped hourly). The reach is unchanged and deliberate; it is no
longer silent.

### Upgrading

Pre-upgrade sessions may carry a collapsed `workspace:view:*` wildcard that
satisfies publish checks until they refresh (bounded by the access-token TTL);
force re-login via session revocation if that window matters. Clients that
sent `visibility` through the generic view PUT now receive 422 — use the
dedicated visibility endpoint.

## [Unreleased] — Invite links that actually work, and can be taken back

### Security

**Signing someone out did not sign them out.** Revoking a user's sessions —
whether an admin killing a compromised account or a role change forcing new
claims — wrote the session id to a Redis tombstone list that `/auth/refresh`
never consulted. Worse, a refresh does not reuse the session id; it mints a
fresh random one. So the sequence was: access token rejected once, the browser
silently refreshes (which it does automatically), a brand-new session id comes
back that was never on the list, and the session continues. The only thing that
ever really ended a session was suspending the account, which `refresh` happens
to re-check for other reasons.

Revocation now also stamps `users.sessions_valid_from`, and a refresh token
minted before that instant is refused and its family killed. The Redis
tombstone still covers the minutes until the access token would have expired;
the cutoff covers everything after. Tokens issued before this release carry no
mint claim and are honoured, so upgrading does not sign the estate out.

### Added

**You can manage your own account.** Every account action in this product was
something an administrator did to somebody else — Admin → Users could rename
you, reset your password, suspend you — and there was no screen where you could
do any of it yourself. For the sole System Administrator that meant editing your
own row through a table built for managing other people, and changing your own
password through a form that never asked what the old one was.

**Account settings**, in the profile menu, now covers:

- **Your name**, including an optional **display name** for people whose name
  is not simply their first and last. Clearing it goes back to the derived one.
- **Your password**, which asks for the current one — the only password entry
  point in the product that does, because it is the only one not already behind
  an admin or a one-time token. Changing it signs out every session, including
  the one you are using, which is now true rather than merely claimed.
- **Sign out everywhere**, for when you think somebody else has your session.
- **Recent activity** — password changes, resets and revocations on your
  account, and whether an administrator did them. Nothing previously showed
  these events to the person they were about.
- **Your avatar**, which is now stored on the account. It was a browser-local
  preference, so it silently reset on a new machine and nobody else ever saw it.

**Single sign-on is now genuinely the source of truth for the profile.** It
previously seeded a name at just-in-time provisioning and never looked at it
again — so a rename in the directory never reached the product, and the profile
drifted from the directory permanently. Groups and mapped attributes have always
re-synced on every sign-in; names simply never did.

They do now, and the fields the provider asserts are shown locked and attributed
on the account page rather than as editable boxes whose values quietly revert.
Writes to them are refused for administrators too: being an admin does not make
the edit survive the next sign-in, and an override that silently disappears is
worse than a clear refusal.

Three details make it usable rather than obstructive. It is **per field** — a
directory that releases `given_name` and no `family_name` owns only the first,
because locking whatever an account happens to have linked would hand people a
blank name they could never fill in. It follows **what the provider actually
sent**, so a claim removed from the mapping hands the field back at the next
sign-in instead of staying locked on the strength of an old login. And
**display name is never owned**, which is what keeps the page worth opening for
an SSO account. Where two providers are linked, the one you most recently signed
in with wins — the rule group memberships already followed.

**The account page was rebuilt around identity rather than around a form.** It
opens with who you are — avatar, name, role, and the methods that can sign you
in — instead of a stack of equally-weighted input cards. The password form is
collapsed until asked for (expanded, it was the largest thing on the page),
Save appears only once something has changed and follows you down the page,
and signing out everywhere moved into its own zone rather than sitting beside
an ordinary Save button.

**The default administrator password cannot be kept.** A fresh deployment seeds
an admin from `ADMIN_PASSWORD`, and a log line asking the operator to change it
was the only control — while the value itself is printed in the README, the
quickstart compose file, and every setup doc. When the seeded password is one of
those published defaults the account must now choose a new one at first
sign-in, enforced by the API rather than by a redirect the client could decline
to follow. Supplying your own password skips the prompt entirely. Admin → Users
badges any account still in that state.

**A locked-out sole administrator can get back in.** `Forgot password` sends
nothing — this deployment has no email infrastructure — it flags the request for
an administrator, which for the only administrator is themselves. There is now
`python -m backend.scripts.reset_admin_password --email …`, which prompts for
the password rather than taking it as an argument and revokes every existing
session. Host access is the authorisation model, which is why it is not an
endpoint.

**Reset password is a labelled button.** It was an unlabelled key icon in a row
of unlabelled icons — the single action people come to that screen for, findable
only by hovering things.

### Known limitations

**Account activity starts at upgrade.** The events behind it were always
written, but without the subject columns needed to find them by account without
scanning the table. Only events recorded after this release appear, so an empty
list means "nothing since you upgraded", not "nothing ever happened". The page
says so.

**"Sign out everywhere" includes the device you are on.** Keeping the current
session alive would mean re-issuing its cookies past the revocation cutoff,
which needs session-minting surface on the auth service that is deliberately
being kept thin ahead of extracting it. The button says what it does.

**Email is still not self-editable.** It is the identity-provider key, so
changing it is a re-link, not a text field.

### Fixed

**The admin profile edit returned stale data.** Saving a name change wrote it
correctly but answered with the values from before the edit, because the write
went around SQLAlchemy's identity map while the response read through it. The
database was always right; the screen just did not show it until a reload.
**Signing into one environment logged you out of another, and no session survived a
redeploy.** Users bounced straight back to `/login` after signing in, got logged out on
clicking any section, and saw `Refresh rejected: Signature verification failed` in the
backend log. Moving between two deployments — `dataviz-dev.local` and `dataviz-uat.local`,
even on separate clusters — logged them out of whichever one they left.

Three causes, all in the app layer:

* **Environments were indistinguishable.** Every deployment wrote the same cookie names
  (`nx_access`, `nx_refresh`) and stamped tokens with the same issuer, so a token from one
  was structurally identical to a token from another — only the signature differed. Since
  cookie jars are keyed by *domain*, not by cluster, signing into one deployment simply
  overwrote the other's cookies, and the receiving side could only report an opaque
  signature failure. `AUTH_ENVIRONMENT_ID` now scopes the session cookie names
  (`nx_access_uat`) and binds the environment into the JWT issuer, so the jars are disjoint
  and a cross-environment token fails as a recognisable issuer mismatch. `nx_csrf` is
  deliberately left unscoped — it is read from JavaScript by name, and the double-submit
  check only ever compares it against the header on the same request.
* **Verification accepted exactly one key.** Any change to `JWT_SECRET_KEY` invalidated
  every live session the instant it landed, and because updating a Secret does not restart
  pods, replicas on the old and new key served traffic side by side — with no session
  affinity, the same user flipped between authenticated and 401 request-to-request. That is
  the "click any section and get logged out" symptom. `JWT_SECRET_KEY_PREVIOUS` now holds
  retired keys for verification only, and tokens carry a `kid` header so the right key is
  selected directly.
* **A rejected token was never evicted.** `get_current_user` answered 401 and left the bad
  cookie in place, so the browser re-presented it on every request — and `clear_session_cookies`
  only ever deleted using the *current* process's cookie domain, which cannot match a cookie
  written under a different `AUTH_COOKIE_DOMAIN` or by a sibling environment sharing a parent
  domain. That combination is what made the login loop permanent. Cookies that can never
  verify here are now cleared across every plausible scope (configured domain, host-only, and
  the parent domain), including the pre-scoping names, and the 401 carries a `session_foreign`
  marker so the frontend stops retrying and starts one clean login instead of looping.

Ordinary expiry is explicitly *not* treated this way, so the silent five-minute refresh is
unchanged.

### Added

**`GET /api/v1/auth/diagnostics`** — unauthenticated and secret-free, because it is most
needed exactly when nobody can authenticate. Reports the environment id, issuer, expected
cookie names, active and accepted key fingerprints, whether the request actually arrived over
TLS (honouring `X-Forwarded-Proto`), and for each session cookie presented whether it is
valid, expired, or foreign. The backend also logs an auth fingerprint at startup, so two
deployments can be compared from one `kubectl logs`.

It warns at startup when `AUTH_COOKIE_SECURE=true`, which is worth checking on any `.local`
host: browsers silently discard `Secure` cookies sent over plain HTTP, so login returns 200,
nothing is stored, and the next request is anonymous — indistinguishable from this bug.

### Upgrading

Both new settings are optional and default to today's behaviour.

* Set `AUTH_ENVIRONMENT_ID` per environment (`dev`, `uat`, …) if users can have two
  environments open in one browser. The k8s overlays and the Helm chart now carry it. It must
  be unique and stable — changing it logs that environment's users out once, by design.
* To rotate `JWT_SECRET_KEY` without logging everyone out: copy the current value into
  `JWT_SECRET_KEY_PREVIOUS`, set the new key, deploy, then drop the old entry after
  `JWT_REFRESH_EXPIRY_DAYS`.

### Known limitations

Every k8s overlay still deploys into the same namespace with the same object names and the
same static IP (`deploy/k8s/overlays/*/kustomization.yaml` set no `namespace`/`namePrefix`),
so deploying one environment overwrites another's `app-secrets`, `viz-service`, and ingress.
`deploy.sh setup` also re-mints `JWT_SECRET_KEY` into a per-operator `.env.deploy`, and
applying a Secret does not restart pods. The key ring makes those survivable rather than
session-ending, but they remain worth fixing separately.

### Fixed

**Shareable signup links were unusable.** Anyone who clicked one landed on the login page
instead of the signup form, and the invite was discarded on the way. The `/signup` route was
gated on the `signupEnabled` flag, which knows nothing about invitations — so in the default
invite-only posture (`signupEnabled` off, which is what the flag's own admin copy recommends)
*every* link was dead, for everyone, deterministically. The gate also fired before the flag had
loaded, so it bounced first-time visitors even where self-registration was on. The decision now
lives in the signup page, which can see both the invite and whether the flag has actually
arrived: an invite is never turned away, and nothing is decided on a seeded guess.

**Invited accounts claimed to be self-registrations.** `signup_source` was documented to carry
`'invite'` and never did, which made the column useless for the one question it exists to
answer.

**A team sharing one link hit the rate limiter.** Signup was capped at 5/minute per IP, so the
sixth person behind an office NAT was refused — indistinguishable from a broken link.

### Added

**Invite links are now revocable, countable, and auditable.** They used to be fire-and-forget
tokens with no server-side record: a link pasted into the wrong channel worked for every reader
for up to 90 days, and nobody could tell it had happened. Every link now has a row behind it, so
you can:

- **Revoke** one instantly from **Admin → Users → Manage links**, whatever its expiry.
- **Cap** it to a number of people — the link closes itself once the seats are gone. Enforced
  atomically, so two people clicking a one-seat link at the same moment cannot both get in.
- **See who used it**, and when.
- **Restrict it to an email domain** (`company.com`) — the middle ground between a link anyone
  can use and one pinned to a single address, which is what makes a link safe to post in a team
  channel.

**Invited users are signed straight in.** They were already approved and activated by the
invite; sending them to a login form to retype the password they had just chosen bought nothing.

**Workspace admins can invite into their own workspaces.** Previously only platform admins
could invite anyone at all. The rule that keeps it safe is that you cannot grant what you do not
hold: non-privileged roles only, no organisation-wide groups, and only into workspaces you
administer. Each person sees and revokes only the links they created.

**`inviteLinksEnabled`** — a switch for the invite-link capability, separate from
`signupEnabled` so the two doors can be opened independently. Turning it off is a kill switch:
links already in circulation stop working immediately, not just new ones. The confirmation
dialog tells you how many live links that will kill before you flip it.

**Links say why they failed.** "Invalid or expired" covered four situations with four different
remedies. A recipient is now told whether the link was revoked, ran out of seats, expired, or
whether invite links are switched off entirely.

**Accept an invite with single sign-on.** An invite meant one thing: choose a password. In an
SSO-only deployment that asked the invitee to invent one that login would then refuse. The
invite page now offers **Continue with &lt;your IdP&gt;**, and the invitation is applied once the
handshake has proved who they are. An invite is only applied to an account with no access yet —
somebody already set up has already been onboarded, and a forwarded link must not add grants to
an established account.

**Invite several people at once.** One list of addresses, one set of settings, one
email-pinned link per person — pinned rather than shared, so each is separately revocable and
each redemption is attributable. Partial success is reported per row: one address already
having an account does not cost the others their invitations.

**Extend or replace a link without losing its history.** **Extend** buys another 30 days (and
more seats on a capped link) while the URL you already shared keeps working. **New URL** issues
a fresh link and stops every URL already sent, keeping the role, groups, seat count and the
record of who has joined on the same invitation. Previously both meant minting a replacement,
which split one invitation across two rows and stranded its history on the dead one.

**A capped link says so.** "2 spots left · Expires in 3 days" on the signup page, so the person
who clicks one too late is not the only one who ever finds out there was a limit.

**Invited users land somewhere useful.** Redemption opens the Getting Started hub once instead
of dropping a brand-new person onto a cold dashboard.

**The notification bell does something.** Its first real content is invite activity: who signed
up through your links, and when. Sending an invitation and never hearing whether it worked left
you with no idea whether to follow up or let it expire.

**Admins can add people directly, one at a time or from a list.** Until now the only way
in was a link somebody had to click — which does not help when there is nobody to hand a link
TO yet: someone starting Monday, an account migrated from another tool, a shared operations
login. **Add people** in Admin → Users creates the accounts outright, with the same role,
workspace and group choices an invite carries, because the account that comes out is the same
account either way.

Three ways the new account can first sign in. The default, **a setup link**, leaves no
password on the account at all — the person chooses their own, so nobody, including the admin
who created it, ever knows it. You can also **set a password yourself** (quick, but you will
know it, and nothing sends it for you), or leave it **SSO-only**. A shared password across a
batch is refused outright: a password twenty people know is not a credential.

A pasted list accepts `Name <a@b.com>` as well as bare addresses, drops repeats, and fills in
missing names from the address — `grace.hopper@` becomes Grace Hopper — with the derived names
shown on the review step rather than discovered afterwards in the user list. Every row reports
its own outcome, so one address that already has an account does not cost the others theirs.

**Creating a link is a wizard, not a wall.** "Invite by Link" asked seven questions at once
— role, workspace, groups, recipient, expiry, seat cap, domain — with no starting point, and
parked the sentence describing the whole invite below the fold, under the fields it was meant
to check. It is now a four-step wizard built to the same pattern as the view and asset
onboarding wizards: its own overlay, a header stating which step you are on, a progress rail
whose completed steps carry a one-line summary of what you chose and can be clicked to go
back, directional transitions, keyboard navigation with a focus trap, and a guard against
closing with work in progress. The steps are *who it's for → what they get → safety →
review*, in that order because the first question is the only one that constrains the others
— and the one the inviter can already answer before opening the dialog, so it carries the
defaults for everything downstream.

**The link itself gets a proper hand-off.** Generating one used to drop a result card into
the same modal shell. It now ends on a success screen: the URL as the hero, monospaced and
copyable in one press, with what the link grants, who it is for, its seats and its lifetime as
tiles beneath — and a plain statement that this is the only time the URL is shown, because the
links list deliberately never returns it again.

**A link's reach is visible before it is minted.** The safety step shows how far the invite
actually reaches — audience, seat cap, lifetime and role, as a single meter with the reasons
written beside it — so "anyone · unlimited · 90 days · org admin" feels different from "one
person · 1 seat · 7 days" at the point of creation rather than in an audit later.

**An open link arrives bounded.** Picking "anyone with the link" used to be the *default*
state, at unlimited uses for 30 days — the widest invite the product can mint, reached by
touching nothing. It now arrives capped at 5 people for 7 days and says so on the way past.
Unlimited is still one click away; the difference is which direction you have to move to get
there. A link pinned to one address defaults to a single seat and no longer offers a seat cap
at all, because it cannot use one.

**Privileged role descriptions are readable.** They were clamped to one line, so every one of
them was cut mid-sentence — "Platform owner. Carries system:admin; implies every permission,
…" — on exactly the choices where knowing what you are granting matters most.

**The email-pin rule explains itself.** Attaching a privileged role or a group to a shareable
link used to grey out the submit button with the explanation in a different column. It now
names the conflict against the audience already chosen and offers both resolutions: pin it to
one person, or take the documented override.

**The links panel leads rather than lists.** It opens on what needs doing — how many links are
live, how many people have joined, and how many are about to expire or run out of seats — and
sorts by urgency so the link you came to deal with is at the top. You can create a link from
the panel that manages them, which previously meant closing it to find a different button.
Search and sort appear only once there are enough links to need them, and a single contextual
tip surfaces things worth knowing (an uncapped link with no restriction on who can use it, for
instance) and disappears when they stop being true.

### Security

Auto sign-in makes the signup endpoint's enumeration-safe response distinguishable for someone
holding a valid invite (the created path sets cookies, the already-exists path does not). This
is an accepted trade, not an oversight: it requires a live invite, every probe is bounded by
that invite's seat cap, and the ledger records who held it. Documented at the call site.

**Node sorting is now enforced by the server.** `nodeSortingEnabled` had no backend half at
all: an admin could switch node sorting off, the canvas would hide the sort menu, and anyone
posting to the view-layout endpoint directly would still set sort modes and custom orders — the
exact "toggle that only hides a button" the feature registry's drift guard exists to prevent.
View-layout writes now strip `nodeSortMode`, `orderKey` and `defaultNodeSortMode` when the flag
is off. It strips rather than refuses, because the canvas rewrites the whole layout on every
gesture and a 403 would block someone for dragging a node; orders already stored are untouched
and still render, exactly as the flag's admin copy promises.

### Fixed

**The feature registry was under-reporting itself.** `nodeSortingEnabled` had no wiring entry
at all and `toursEnabled` declared no UI surfaces despite being read in six components, so the
admin Features page reported both as "not implemented" and two drift-guard tests failed on
`main`. Both now declare what actually exists. The end-to-end registry test has also been taught
the `stage` exemption that `feature_wiring.py` documents and its sibling test already applied —
experimental flags are not required to have a server gate yet, which is the whole reason the
stage exists. Active flags are still checked in full.

**Nothing in the invite dialog had an edge.** Every unselected chip, role row, group row and
text input used the house `border-glass-border` recipe, which in light mode is a *white*
hairline — so inside a dialog that is itself `bg-canvas-elevated`, the form rendered as
floating text and only whichever option happened to be selected looked like a control. Same
root cause as the rows below, fixed the same way, and limited to this flow.

**Invite rows had no edges.** They used the house `border-glass-border` recipe, which in light
mode is a *white* hairline — it works everywhere else because those cards sit on the page
background and take their edge from the fill, but this list lives in a drawer that is the same
colour as the cards, so the rows dissolved into one stream. They now draw a real hairline.
Separately, `bg-accent-lineage/10` and friends emit no CSS at all — Tailwind cannot apply an
opacity modifier to a variable holding a full hex — so every tint in the panel was silently
invisible, including the seat meter's track. This panel now uses the palette colour the token
resolves to, which renders. The same class is used ~850 times elsewhere in the app and is
untouched here; worth a separate look.

---

## [0.2.0] — 2026-07-19 — Versioned Graph: rollback, admin flag, and enable-VC at scale

Version control for a data graph becomes usable on a *real* graph: you can turn it on for a
data source you already have, undo a change you already published, and switch the whole feature
off for a deployment that doesn't want it.

Verified end to end against a live **7.7M-entity** graph (2,083,216 nodes / 5,009,794 edges).

### Added

**Roll back a change you already published.** Two different operations, because they answer two
different questions:

- **Undo this change** — reverses one published revision and *keeps* everything that came after
  it. If later work touched the same items, it can't be undone in isolation; the dialog says so,
  names how many items collide, and offers the way out.
- **Restore the graph to this point** — resets the graph to how it looked at a chosen revision.
  It cannot conflict, by construction, which is exactly why it's the escape hatch when an undo
  can't proceed. Shows the exact impact before you commit to it.

Both add a **new revision**. History is never rewritten, and nothing is destroyed. Available
from the history timeline and from a merged pull request.

**Turn on version control for a data source you already have.** Previously this had to happen
in a single request and was not viable on a large graph. It is now a background job:

- Runs asynchronously — you keep working while it copies.
- **Resumable.** A killed worker picks up exactly where it stopped; it does not start over.
- **Proves itself.** When it finishes you get an integrity report — every item and connection
  counted against the source, every item type and relationship type checked for survival, no
  duplicate identifiers, no dropped connections, and a random sample re-read from the source and
  compared byte-for-byte. On the 7.7M graph: *"scanned 2,083,216 of 2,083,216 items · 5,009,794
  of 5,009,794 connections · 64 of 64 re-checked items match exactly · zero data loss."*
- **Invisible until proven.** Nothing becomes live until the checks pass, so a failed copy leaves
  your data source reading exactly as it did before. There is nothing to undo.
- Live progress with a time-remaining estimate, and — if something goes wrong — a plain-language
  reason plus Resume / Start over / Give up, and a downloadable report.

**An admin switch for the whole feature.** `Admin → Features → Version control`. Turn it off and
the versioning UI disappears and the server refuses versioning writes. Existing versioned graphs
stay **viewable, read-only** — nothing is deleted and nothing is hidden from you permanently.

**Enable-version-control jobs are visible to operators.** `/admin/infrastructure` gains a panel
for copies that are running, stalled, or failed. This matters more than it sounds: a graph being
copied deliberately parks its projection watermark, which made it read as *healthy and in sync*
to every other probe — so a copy that failed days ago, while silently blocking writes to its data
source, showed up as green.

### Changed

**Breaking — API.**

| Endpoint | Before | Now |
|---|---|---|
| `POST /{ws}/graph/bootstrap` | synchronous; returned the result | **`202` + `{jobId, graphId, status}`**; poll `GET /{ws}/graph/bootstrap/status` |
| `POST /{ws}/graph/bootstrap` | no permission check | requires **`workspace:datasource:manage`** |
| `POST /{ws}/graph/resync` | `workspace:datasource:read` | requires **`workspace:datasource:manage`** (see *Security*) |
| canvas write-through | silently enabled version control for you | raises a typed **"enable version control first"** error |

**New endpoints:** `GET /{ws}/graph/bootstrap/status`, `POST /{ws}/graph/bootstrap/retry`,
`POST /{ws}/graph/bootstrap/abandon`, `POST /{ws}/versioning/graphs/{gid}/commits/{cid}/restore`,
`GET  /{ws}/versioning/graphs/{gid}/commits/{cid}/restore-preview`, and the public
`GET /api/v1/features/values` (UI booleans only — no schema, no admin hints, no secrets).

**A data source on a non-FalkorDB provider is now refused up front** with `422
provider_unsupported`, instead of being accepted with a `202` and failing later. The copy is
FalkorDB-shaped end to end; accepting it and failing afterwards left the data source **write-
blocked behind a job that could never succeed**.

**New commit kind `restore` and new job type `bootstrap`** — both require the migrations below.

### Security

**`POST /{ws}/graph/resync` was a write gated on read.** The graph router's blanket dependency is
`workspace:datasource:read`, and that route added nothing on top — so anyone who could merely
*look* at a data source could commit a `sync` to its main branch, overwriting source-authoritative
fields across the whole graph and, with `strategy=external_wins`, deliberately clobbering other
people's edits. It now requires `manage`, like every other write on that router.

Tenant isolation was already sound here (cross-workspace requests already 404'd), so this is a
privilege bug, not a cross-tenant one.

*Also noted, not fixed:* `POST /{ws}/graph/vocab-alignment/confirm` is in the same state — a write
with no permission dependency beyond the router's read.

### Upgrading

**Migrations are mandatory.** Run `alembic upgrade head`. The runtime's `create_all` never ALTERs
an existing table, so an existing database will **not** self-heal:

- `20260713_1200_restore_kind` — allows `commits.kind = 'restore'`.
- `20260713_1400_jobs_bootstrap` — allows `jobs.job_type = 'bootstrap'`. **Widen-only**
  (`required ∪ present`): `graphver.jobs` is a shared, multi-producer table, and a CHECK rebuilt
  from a hard-coded allow-list has wedged Alembic on it before.

**The worker must be running.** Enabling version control is now a job, claimed by the versioning
worker (`python -m backend.app.services.versioning`, or `GRAPHVER_PROJECTION_INPROCESS=1` in dev).
Without it, jobs sit in `pending` forever.

**New tuning knobs** — all optional, all sized for a 10M-entity graph. Full table with defaults and
rationale in [`docs/VERSIONING_E2E.md`](/docs/versioning-e2e#tuning-all-optional-defaults-are-sized-for-a-10m-entity-graph):

`GRAPHVER_BOOTSTRAP_SCAN_WIDTH`, `_SCAN_MIN_WIDTH`, `_EDGE_TARGET`, `_WINDOW`, `_SAMPLE_K`,
`_MERKLE_MAX`, `_RETRY_BUDGET_SECS`, `_RETRY_MAX_DELAY_SECS`, `GRAPHVER_INGEST_POLL_SECS`,
`_STALE_SECS`, `_HEARTBEAT_SECS`, `GRAPHVER_RESYNC_MAX_ENTITIES`.

### Known limitations

**Re-sync holds the whole graph in memory, several times over.** Measured: **2.03 GB of RSS to
compute 808 changes** on a 478,430-entity graph — in one HTTP request, on the web tier. It scales
linearly, so a 7.7M-entity graph would ask for roughly **30 GB** and take the API process down,
along with every request in flight on it.

This is **pre-existing** and untouched by this work. But this release is what makes graphs that
large versionable in the first place, so it now ships behind a guard rather than a crash: re-sync
**refuses** above `GRAPHVER_RESYNC_MAX_ENTITIES` (default 250,000) with `422
graph_too_large_to_sync`, quoting the item count and the memory it would need. Refusing beats an
OOM on every axis — an OOM kills unrelated requests and explains nothing.

The design that removes the guard entirely is written out in
[`docs/versioning/11-resync-at-any-scale.md`](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/11-resync-at-any-scale.md).

**Enabling version control is FalkorDB-only.** Other providers are refused with a clear `422`.

**The integrity fingerprint (Merkle root) is deferred above 1,000,000 entities** rather than built
in memory. The integrity checks still run in full, and the report says when it was deferred.

### Verification

The 7.7M-entity run, end to end:

| | |
|---|---|
| copied | 2,083,216 nodes / 5,009,794 edges — **exact match to source** |
| containment (`HAS`) | 2,083,200 → 2,083,200 |
| lineage (`FLOWS_TO`) | 2,926,594 → 2,926,594 |
| duplicate rows | **0**, across a SIGKILL and three resumes |
| sampled items re-read and hash-compared | 64 / 64 identical |
| peak worker memory | **468 MiB** — sized by the window, not the graph |
| projection | fast-forwarded; the source graph was never dropped or reseeded |
