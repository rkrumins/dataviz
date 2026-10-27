# Hybrid version control on a data source's own graph — capturing outside writes (design)

**Date:** 2026-10-27 · **Branch:** `claude/versioning-external-graph-safety` · **Status:** follow-up,
awaiting user review

## 0. The ask (user, verbatim)

> "Can we ensure we fully support the reporting of such misalignments, missing ids and etc as well
> as support hybrid flow where history can be kept when teams continue to write in a graph behind
> the scenes and we resync it to history and etc? The hybrid flow can be added as a follow up
> feature"

Operational reading. A data source's own graph under version control has two writers: the
platform, from the history (drafts → publish), and a team's pipeline, loading straight into the
graph. Today the history takes over (ruling Q1 of this branch): what the pipeline writes is drift —
kept, shown in Views, **reported** under Data health → *Outside the version history* — but no
draft, publish, history or restore covers it. **Hybrid makes the pipeline a co-author**: its writes
are *captured* into the history as commits, so everything in the graph is versioned, and neither
writer silently overwrites the other.

## 1. What this builds on

| Piece | Where | Its role in hybrid |
|---|---|---|
| Drift counts and lists | `reconcile.outside_history_counts`, `alignment_rows`, `projection_state.drift`, `GET /graph/misaligned-items` | Enumerate what the pipeline added — cheaply, by the missing stamp |
| Identity stamped in the graph | `n.entityId`, `r.id` — written by the enable job and every projector write | **Exact** identity for every tracked item: no urn guessing |
| The enable job | `bootstrap_worker.py`: windowed reads, identity stamping, edge re-keying, the duplicates pre-flight and decision, the spelling refusal, the integrity report, leases, resumable phases | A capture is an *incremental* enable: the same machinery over what is new or changed |
| The authoritative re-sync | `sync_ingest`: 3-way merge, `sync` commits, `merge` / `external_wins`, `resolutions` ([10](../../versioning/10-authoritative-sources-datahub-openmetadata.md)) | The commit and conflict semantics |
| Re-sync at scale | [11](../../versioning/11-resync-at-any-scale.md): hash discard, id set, worker job — partly built | How a capture stays O(window); **its warning applies in full** |
| `GraphORM.kind = 'hybrid'` | `models.py` (`ck_graphs_kind`) — nothing sets it today | Marks a hybrid source |
| The pipeline's refresh signal | `signal_source_changed` — now recorded and answered `version_controlled` for a versioned source | The natural trigger |
| Review Center | merge requests, resolutions | Where conflicts go |

## 2. Constraints

- **C1 — Identity is the stamp, never the urn, for anything the history tracks.** Doc 11's bounded
  re-sync resolved identity by urn, passed every test built with `bulk_ingest`, and on a
  bootstrapped graph deleted and re-created all 478,430 entities. On a data source's own graph,
  every tracked node carries `entityId` and every tracked relationship `id`: a capture resolves
  tracked items by those, and only *unstamped* items (new ones) by `(label, urn)`.
- **C2 — Neither writer clobbers the other silently.** Today a publish writes each touched entity's
  whole payload (`SET n += nativeProps`), so it overwrites any pipeline edit to *any* field of that
  entity; and an additive heal re-creates a tracked item the pipeline deleted. Both must change for
  a hybrid source.
- **C3 — FalkorDB has no change feed.** New items are found by the missing stamp. An *edit* to a
  tracked item can only be found by reading it: `gvHash` hashes the history's payload, not the
  graph's current properties.
- **C4 — Deletion by absence is the dangerous direction**: bounded, previewed, and never applied to
  an identity the capture couldn't resolve. Doc 11's failure *was* mass deletion.
- **C5 — Scale (doc 11).** A capture is a worker job — 202, progress, resumable, idempotent — with
  O(window) memory. Never the web tier.
- **C6 — One history.** A capture commits as the pipeline's identity (its service account), and is
  reviewable like any change.

## 3. Rulings needed

1. **Who owns what.** Recommended: a per-source **ownership map** — the pipeline owns the existence
   of declared entity types and the values of declared fields (say, schema and row counts on
   `Dataset` and `Column`); people own the rest. Ownership settles most conflicts by declaration.
   The alternative is one 3-way policy for everything (`merge` / `source_wins` / `history_wins`).
2. **Review.** Captures publish directly; or go through review only when they conflict
   (recommended); or always.
3. **Deletions.** The pipeline's absence deletes from the history (bounded and previewed) for the
   types it owns; or deletions are only flagged.
4. **Trigger.** The pipeline's refresh signal (recommended); a schedule; or by hand only.

## 4. Design

### 4.1 A hybrid source

`kind = 'hybrid'` and a per-source `hybrid` setting:
`{ownership: {types, fields}, review: "conflicts" | "always" | "never", deletions: "flag" | "apply",
maxDeletionPct, trigger: "signal" | "schedule" | "manual"}`. A capture is a `sync` commit whose
**base** is `main` at the previous capture, **ours** is `main` at its head, and **theirs** is the
live graph, read through the ownership map.

### 4.2 The capture job — an incremental enable

1. **Pin.** Record `main`'s head `S` and require the projection to be fresh at `S`
   (`projected == committed`), so for tracked items the graph holds at least what the history does.
   No long lock: at commit, a capture whose touched entities moved past `S` re-classifies just those
   (optimistic, as a draft rebase does).
2. **Read in internal-id windows** (as `alignment_rows` does):
   - unstamped nodes, and unstamped relationships between keyed endpoints → **new**. A second copy
     of a tracked item (`alsoInHistory`) goes to the enable job's duplicates decision, never merged
     silently; an item with no identifier stays reported only.
   - stamped items of owned types → compare their owned fields with `main`'s payload, hashed on the
     fly, discarding the equal → **changed**.
   - with `deletions: apply`, tracked ids of owned types the read didn't see → **deleted**, decided
     against an id set staged per window (doc 11 §2), never against an in-memory map.
3. **Classify 3-way** against base and ours: a change only the pipeline made is taken; one only
   people made is kept; both → the owned side wins, else a **conflict**.
4. **Preview, and refuse** when deletions exceed `maxDeletionPct` of the tracked items of owned
   types, or when a capture of an unchanged graph would apply more than ~0 changes — the invariant
   that would have caught doc 11's failure in seconds.
5. **Commit** one `sync` commit — or a draft and a merge request, per `review` — authored by the
   signalling identity, idempotent on the capture's id.
6. **Stamp** `entityId` on captured nodes and `id` on captured relationships, as the enable job's
   backfill does, so the next projection pass finds them by identity and writes nothing. (The
   projector merges relationships on a customer graph by `id`; an unstamped one would be duplicated.)
7. **Verify.** The projection catches up, and the drift recount shows the captured items as
   tracked.

### 4.3 Projector changes for a hybrid source

- **Field-level writes.** Write only the fields the window changed — `_window_meta` already reads
  each entity's value before the window — never the whole payload. A publish then never overwrites
  a pipeline-owned field it didn't change. This helps every customer graph, hybrid or not.
- **Heal respects ownership.** A tracked item of a pipeline-owned type missing from the graph is a
  pending deletion for the next capture, not damage: the heal leaves it gone.
- **Capture before rebuild.** A rebuild of a hybrid source first runs a capture, so nothing the
  pipeline wrote is reported as lost.

### 4.4 Triggers

The pipeline's refresh / `source-changed` signal — answered `version_controlled` today — schedules
a capture on a hybrid source: debounced, one in flight per graph, a signal during a capture queuing
one follow-up. Optionally a schedule, and **Bring into history** in Data health, which shows the
preview first.

### 4.5 Conflicts and review

Ownership settles most. A residual conflict (both changed a field neither owns) opens a merge
request in the Review Center, authored by the pipeline's identity, and is resolved with
`sync_ingest`'s `resolutions` — or by the source's policy, `source_wins` / `history_wins`.

### 4.6 Reporting (extends this branch)

Data health gains **Pending capture** (new / changed / deleted, from the last preview), **Outside
ownership** (the pipeline wrote a field people own: reported, and overwritten by the next publish
of that entity), and the last capture's time and commit. The watermark's `drift` gains
`pendingCapture`.

## 5. Order of work — each step ships on its own

1. **Characterisation tests first**, on a *bootstrapped* customer graph: a capture of an unchanged
   graph applies 0 changes; new items are captured and stamped; nothing tracked is touched.
2. **Capture new items only**, by hand: new nodes and relationships become a `sync` commit and are
   stamped; duplicates go to the decision flow; no deletions and no field edits. Lowest risk,
   largest value: what the pipeline adds becomes versioned.
3. **Field-level projector writes** (no clobbering) — useful on its own.
4. **The ownership map**, and capturing changed owned fields (windowed compare, worker job).
5. **Deletions** (ceiling and preview) and the **signal and schedule triggers**; review routing.
6. **Scale per doc 11** (staged id sets, streamed reads); then the re-sync size guard can go for
   captures.

## 6. Non-goals

- Writing the history back into the pipeline's own source system.
- Capturing items with no identifier: they stay reported.
- Hybrid for graphs the platform owns (blank models, package seeds): nothing else writes to them.

## 7. Risks

- **Mass deletion through an identity failure** → C1, the deletion ceiling, the preview, and the
  unchanged-graph invariant.
- **Holding a huge graph still while it is read** → no lock; pin a head and re-classify what moved
  past it (4.2, step 1).
- **The pipeline and people editing the same field** → the ownership map makes it a declaration
  rather than a race.
