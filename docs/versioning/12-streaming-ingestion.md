# INGEST: continuous streaming delta ingestion, final spec

This spec covers continuous ingestion of graph changes from Kafka (OpenLineage and canonical formats) and from the customer's original FalkorDB graph. All changes land in versioned graphs that live on platform-owned projections, with protected main.

All line numbers below were checked against the working tree on 2026-10-09. Code that "exists" is cited as `path:line`. Anything marked NEW does not exist yet.

---

## Summary

**One write primitive.** Streaming ingestion goes through `GraphVersioningService.apply_source_delta(graph_id, *, principal, source, envelopes, delivery, …)`. It runs as a single graphver transaction under `_lock_graph` (service.py:5370) with a 1 s `lock_timeout`, in the ingest gate order of contract §7:
1. writability check;
2. source-state guard;
3. origin-offset fence (live delivery only);
4. per-path last-writer-wins (LWW) fold into a CRDT shadow (`source_assertions`);
5. identity resolution under the lock (§13);
6. three-way merge driven by field policy, reusing `three_way_merge` (merge.py:91) with base = shadow, ours = main head, theirs = new shadow;
7. scope retractions, delete governance and a mass-delete circuit breaker;
8. the shared tail `_commit_values`, extracted verbatim from `_apply_ops_once` (service.py:5420, tail at about 5496-5609). It writes one commit with `kind='ingest'`, `actor='svc:ingest:<sid>'` and `actor_kind='service'`;
9. issues, shadow, offsets and the storage counter, all in the same transaction.

**Two producers feed it, under one source state machine:**
- **ingest-worker** (Kafka). The router decodes raw topics (OpenLineage or canonical) into ChangeEnvelope v1 and re-keys them by graph onto `graphver.changes`. The applier runs one GraphActor per graph, with a single commit in flight.
- **falkordb_snapshot binding** (X-07). CONVERSION's `drift_sync` job calls the same primitive with `delivery='snapshot'`. Drift between the customer's original graph and the converted one therefore lands in the same issues inbox.

**Exactly-once effect.** Three properties together give it:
- the re-key prefix property plus the Postgres origin fence (live delivery);
- the CRDT shadow, which makes replay, redrive and snapshot deliveries safe without the fence;
- single-transaction atomicity.

Kafka offsets are only low-watermark hints. Pause, resume, rewind and redrive are per-partition router flips followed by replay jobs. Envelopes still in flight for a source that is not applyable are held as rejects in Postgres, never dropped.

**How the user decisions are met:**

| Decision | How this spec meets it |
|---|---|
| D1 (platform-owned keys) | Activation needs `lifecycle_state='live'` AND `projection_state.owns_falkor_graph` AND `falkor_graph_name IS NOT NULL`. The projector refuses to project ingest commits into a key the platform does not own. |
| D2 (overlap-only gate) | Overlap with human or system commits, or structural overlap, raises `not_up_to_date`. Overlap with service commits alone joins the bounded merge, so a stream can never livelock people. |
| D3 (retention) | Only `main ∧ kind='ingest' ∧ actor_kind='service'` commits older than N days (minimum 7) are compacted, into daily checkpoints. A protected-seq set (including `graphs.cutover_seq`) is never touched. Readers inside a compacted range get 410 `history_compacted`. Every graph has a budget, and `storage_guard` throttles or pauses. |
| D4 (access and review) | A source is a service principal, bounded by an approved, versioned policy. Approval needs `datasource:publish`, with four-eyes on protected graphs. Taking a source value onto main needs P. A custom value onto main is `MAIN_WRITE_THROUGH`. |

---

## Goals / non-goals

### Goals
- **G1. Zero loss, exactly-once effect.**
  - Every routed raw record ends in exactly one durable outcome: applied, no-op, fenced duplicate, quarantined issue, or held/rejected row that can be redriven.
  - No crash, rebalance, zombie, pause/resume, rewind, redrive or lifecycle transition can move state backwards.
- **G2. Coexistence.**
  - A source never silently overwrites a curated value: source-owned paths leave an `overridden` receipt, and shared paths park a `conflict`.
  - A source never deletes an entity created by a person.
  - Publish and merge never livelock behind a stream (D2).
- **G3. Governance (D4).**
  - A source writes only within its mapped types, its field policy minus graph guardrails, and its own shadow (for deletes).
  - Every commit records `policy_version`, the approver and origin offsets.
- **G4. D1.** Ingest writes Postgres only. It is projected only into owned keys, and the customer's original key is never written.
- **G5. D3.** Compaction preserves as-of reads exactly at every kept seq. Budgets drive alerts, throttling and pausing.
- **G6. Operability.** Pause, resume, replay/rewind, confirm-deletes, redrive and discard; a mandatory dry run before activation; metrics within the 500-series cap (`metrics_prometheus.py:49`); SLOs and runbooks.
- **G7. Envelope.**
  - Scale: 500+ graphs, about 4.8M OpenLineage events per day, bursts of 2,000 events/s, hundreds of concurrent editors.
  - Latency: event-to-commit p95 under 30 s; event-to-FalkorDB p95 under 90 s.
  - Human impact: publish p95 within 20% of the no-ingest baseline.

### Non-goals (v1)
- Cross-data-source lineage edges. These become `foreign_endpoint` issues.
- A review-before-landing mode for streams. The alternative is file import into a draft, then a PR.
- An HTTP push endpoint.
- Re-keying identities when a mapping changes.
- Versioned run history. Only the latest run per job is kept, in `ingest_run_state`.
- Kafka EOS transactions and a schema registry.
- DataHub and OpenMetadata decoders. The plug-in contract supports them.
- Draft-row retention.
- Repartitioning `graphver.changes` in place. The answer is to cut over to a `.v2` topic.
- Drift detection or release rules of its own. These belong to CONVERSION's `drift_scan`, release eligibility and `lifecycle/adopt` (X-19).

---

## Concepts, roles & state machines

### 1. Principals and authorization (contracts §1, §2, §12)

| Actor | Actor string / kind | Entry points |
|---|---|---|
| Ingest source | `svc:ingest:<sid>` / service, built by `Principal.service(sid)` | Only `INGEST_APPLY`, via `apply_source_delta`. Never reads or writes drafts or PRs. |
| Snapshot sync | `system:sync` / system | `sync_ingest`. `source_ref.requested_by` holds the human. |
| Storage guard | `system:storage_guard` | Writes `storage_state`; throttles and pauses sources. |
| Compaction | `system:compaction` | Compaction jobs. |
| Lifecycle hook | `system:lifecycle` | Lifecycle-driven pause, resume and retire. |
| Human | `<user_id>` / human | Admin API. |

**New `Action` members** in `versioning/access.py` (X-04). All are non-legacy, so they enforce from day one with no shadow mode (X-20):

| Action | Level | Covers |
|---|---|---|
| `INGEST_CREATE` | M | Create, edit, propose, dry run, view rejects |
| `INGEST_APPROVE` | P | Approve a policy. Also `approver ≠ policy_proposed_by` when `graphs.require_review` (403 `access_denied` code `self_approval_forbidden`). |
| `INGEST_ACTIVATE` | P | Activate, confirm-deletes, retire |
| `INGEST_PAUSE` | M | Pause |
| `INGEST_RESUME` | P | Resume |
| `INGEST_REPLAY` | P | Replay or rewind |
| `INGEST_REJECT_ADMIN` | P | Redrive or discard rejects |
| `INGEST_ISSUE_DISMISS` | M | Inbox "Keep current" |
| `INGEST_ISSUE_RESOLVE_MAIN` | P on every graph | Inbox "Take source" onto main |
| `STORAGE_EDIT` | A | Budget and retention |
| `INGEST_APPLY` | service | Allowed iff all hold: `source.graph_id = graph`; `state ∈ {active, throttled}`; `decoder <> 'snapshot'`; envelope `policy_version = source.policy_version`; `_assert_writable` passes. |

`MAIN_WRITE_THROUGH` and `DRAFT_WRITE` are owned by ACCESS. The inbox's custom "value" and its `target=draft` path use them (X-05).

**Reads.** Sources, status, issues, revisions, entity source chips and storage are all R (`workspace:datasource:read` plus `graph_in_workspace`, versioning.py:408).

**Capability envelope.** Every source resource returns `access:{can, reasons, required}`, built by `access.explain(principal, ctx)`. `ctx` includes lifecycle state, source state, `require_review` and the proposer. The UI renders buttons from `access.can` only. `usePermission` may only hide the Ingest tab.

**Why service commits need no PR.** The D4 review is applied to the standing write envelope (the policy):
- an approved, versioned policy, with four-eyes on protected graphs;
- type mapping;
- field policy minus `graphs.ingest_guardrails.human_paths`;
- delete authority limited to the source's own shadow;
- the circuit breaker.

### 2. Source state machine (`ingest_sources.state`; every transition bumps `state_epoch` and writes `ingest_source_revisions`)

```
draft ──activate(P; dry-run ok; lifecycle live; owned key; no routing overlap; policy approved)──▶ paused
paused ──resume(P; graph writable)──▶ active              (router flips resumed_at; replay job)
active|throttled ──pause(M)──▶ paused                    (router flips paused_at)
active|throttled ──breaker trip (applier)──▶ blocked      (batch + in-flight envelopes held)
blocked ──confirm-deletes apply(P)──▶ active              (held redriven with force token)
blocked ──confirm-deletes discard(P) | pause(M)──▶ paused
active ──storage ≥100% (system:storage_guard)──▶ throttled ──≥120%──▶ paused_budget (state_reason 'budget')
throttled|paused_budget ──<90% (storage_guard)──▶ active  (normal resume path, as system:storage_guard)
active|throttled|blocked|paused_budget ──lifecycle enters frozen|trashed|detaching|ready──▶ paused (state_reason 'lifecycle:<state>')
paused[lifecycle:*] ──unfreeze|restore|cutover-to-live──▶ active (system:lifecycle resume; retention gap ⇒ stays paused, state_reason 'retention_gap')
any ──lifecycle enters detached | release_source (binding) | retire(P)──▶ retired   (terminal; shadow kept)
any ──purge──▶ (rows deleted; revisions kept)
```

**Who may resume.** A human resume needs P and a writable graph (409 `graph_not_writable` otherwise). The system principals `lifecycle` and `storage_guard` may only resume sources whose `state_reason` they set themselves.

**Policy changes on a non-draft source:**
1. The change is stored in `proposed_policy` with `proposed_by`.
2. Approval increments `policy_version`. If routing, mapping, decoder options or URN strategy changed, it also increments `mapping_epoch`.
3. Approval also performs a flip, exactly like pause+resume at the same position, and bumps `state_epoch`.
4. Envelopes in flight under the old `policy_version` are held with reason `policy_changed` (see §4).

### 3. Router partition flips (lossless pause/resume)

**Table.** `ingest_source_partitions(source_id, topic, partition, state_epoch, paused_at_offset, resumed_at_offset)`.

**When a router sees a new `state_epoch`** (30 s rules cache, or a Redis nudge), for each raw partition it owns it writes `paused_at = position(p)` or `resumed_at = position(p)` *before* it changes routing. A new owner of a partition that has no row writes one at its committed offset.

**Resume.** An `ingest_replay` job re-reads `[paused_at, resumed_at)` per partition with group-less, manual-assign consumers, and emits envelopes with `delivery='replay'`.

**Retention gap.** If `paused_at < log_start_offset`, resume returns 409 `retention_gap` unless `acceptGap=true`. Accepting records the gap in a revision.

### 4. Envelope, deliveries and the order key

**ChangeEnvelope v1** (`schema/change_envelope.v1.json`):

```
{v, graph_id, source_id, policy_version, mapping_epoch, state_epoch, delivery,
 origin:{topic, partition, offset} | snapshot:{scan_id, scan_seq},
 assertions:[{op:'upsert'|'retract', kind:'node'|'edge',
              urn? | triple?:{src_urn, edge_type, tgt_urn},
              entity_type, fields, k, strength?:'hint'|'authoritative'}],
 scopes:[{anchor_urn, edge_types[], complete:true, k}],
 run?:{job_urn, run_id, state, event_time, nominal_time, error_message, duration_ms}}
```

**Router invariant.** The router emits exactly one envelope per (graph, origin record).

**Deliveries.**

| `delivery` | Producer | Fenced by origin offset? | Order key k |
|---|---|---|---|
| `live` | router | yes | `(event_time_ms, mapping_epoch, origin_partition, origin_offset)` |
| `replay` | `ingest_replay` job | no; L raised with GREATEST | same as live |
| `redrive` | `ingest_redrive` job | no | the original k |
| `snapshot` | CONVERSION `drift_sync` (falkordb_snapshot binding) | no | `(scan_started_ms, mapping_epoch, 0, scan_seq)` |

**Per-path LWW.** `path_times[path] = max k`. A path is a top-level field or `properties.<key>`.

**Edge existence** is an LWW element set: live iff `max upsert k > retracted_k`; on a tie, upsert wins.

**Time-refresh quantum R** (`INGEST_TIME_REFRESH_SECS`, default 6 h). A no-op re-assertion persists a newer k only if it advances it by more than R. The actor keeps the newest k in memory. The only mis-order window is: a value-conflicting late event from another raw partition, older than the true last-seen by less than R, arriving after an actor restart. It is measured by `gv_ingest_late_applied_total`. R=0 gives exact LWW.

**Applyability (contract §7 step 3), clarified for zero-loss.** INGEST_APPLY denial is never a drop for in-flight data:

| Condition | Outcome |
|---|---|
| state ∈ {blocked, paused, paused_budget} | HOLD: rows in `ingest_rejects` with `stage='held'` and reason `source_<state>`. Resume or confirm-deletes enqueues `ingest_redrive` for them. |
| Envelope `policy_version ≠ source.policy_version` | HOLD with reason `policy_changed`. The redrive re-reads the raw record by origin coordinates from Kafka and re-decodes it under the current policy. If the record is past retention, the reject stays open with reason `retention_gap`. |
| `decoder='snapshot'` | 403 `service_principal_forbidden` (programming error). |
| state ∈ {draft, retired}, or the source row is missing (purged) | Router "ignored". In the applier, a reject with `stage='apply'` and reason `source_<state>`. |

### 5. Identity (contract §13)

**Nodes.** Resolution order:
1. `urn`, through `_heads_by_urn_all` (NEW; returns urn → list of `(eid, hash, tomb)`, because today's `_heads_by_urn` at service.py:5224 collapses duplicates at line 5240);
2. else `graphs.identity_property` (snapshot decoder only);
3. else synthetic: urn `gv:src:<ID>`, entity_id `src:<ID>`.

More than one live candidate opens an `ambiguous_identity` issue and the assertion is skipped. No candidate mints a new id: `node_eid_for_urn(urn)` is deterministic (blake2b of graph and urn), so concurrent first creates converge.

**Edges.** Resolved by live-head triple under the lock, *before* minting, through `_heads_by_edge_triple_all` (NEW variant; service.py:5243 overwrites by triple at line 5265 and includes tombstones):

| Live heads for the triple | Result |
|---|---|
| exactly 1 | reuse its id |
| more than 1 | `ambiguous_identity` |
| 0 | `identity.mint_sync_edge_id(s, T, t)` = `sync:e:<s>-><t>:<T>`, the existing form from service.py:5214 and 5345 |

A conversion-imported edge `a|CONSUMES|b` is therefore updated in place, never duplicated (X-09).

### 6. Per-entity merge (field policy)

**Inputs:**
- `base` = shadow payload (asserted paths only), or None;
- `ours` = main head (`_head_values`, plan 1.6);
- `theirs` = shadow after the fold.

**Policy.** `source_policy.resolve(source.field_policy, graph.ingest_guardrails, SET_FIELDS)`. Guardrail paths always resolve to `human`, so the guardrail wins at runtime even if the source policy predates it.

**(a) First contact** (no shadow row, head live):
- write source-owned paths, plus paths that are *absent* in ours;
- seed the shadow;
- write `overridden` receipts only if the entity has a version from an `actor_kind='human'` commit.

`claim_existing` (default true for converted graphs): when an anchor is first contacted, its incident edges of the scope's edge types whose every version is non-human are seeded into the shadow with `claimed=true`. A later complete scope can then retract stale pre-conversion lineage.

**(b) Normal:**
1. Reset `human` paths in theirs to base.
2. Run `three_way_merge(base, ours, theirs, set_fields=policy.set_paths, keyed=policy.keyed, on_conflict='ours')`.
3. Post-pass: a conflict on a `source` path goes to theirs plus an `overridden` receipt; a conflict on a `shared` path keeps ours plus a `conflict` issue.

**(c) Retraction of an entity with a human-authored version since `first_seen_seq`.** The entity stays live, the shadow is tombstoned, and a `delete_modify` issue opens.

**(d) Placement:**
- `hint` creates a containment edge only when the child has no live parent, and never moves a child.
- `authoritative` moves a child only if its current parent edge is live in *this* source's shadow. Otherwise a `placement` issue opens.

**(e) Out of scope.** Unmapped types and unlisted paths are dropped and counted. One `out_of_scope` row per `type:<T>`.

**Delete governance.** A source may delete only entities live in its own shadow. Breaker: deletes > `max(delete_policy.max_abs, max_pct × shadow_live_count)` without a matching force token raises `BreakerTripped`. The source goes `blocked` and the batch is held.

### 7. Exactly-once proof (summary; full text in docs/versioning/12)

- **Lemma 1 (prefix).** The router consumes in order, uses an idempotent producer (`acks=all`, `max_in_flight ≤ 5`), and commits raw offset `o+1` only after a flush covering `o`. So each routed offset below `o_i` has a copy before position i in π(g).
- **Lemma 2 (fence).** The applier admits a live envelope iff `o > L(g,S,t,p)`, and raises L in the same transaction as the shadow, commit, issues and held rejects. That gives completeness and uniqueness. A crash rolls back everything, and the Kafka commit is only the low watermark of fully processed offsets.
- **Lemma 3 (CRDT).** The shadow update is a join on per-path k. Re-applying or reordering is idempotent, and main receives only the merge of (old shadow → new shadow). So `replay`, `redrive` and `snapshot` may bypass the fence (L is updated with GREATEST only).
- **Audit invariant** per (g, S, t, p), kept in the `ingest_offsets` counters within the same transaction: `routed = applied + noop + fenced + quarantined + held`.
- **Backstop.** `uq_commits_idem` (migration 10) with key `ingest:<sid>:<sha1(sorted origin ranges)>` for live, or `ingest:<sid>:<job_id>:<chunk>` for jobs. A violation counts the envelopes as fenced.

### 8. Ordering
- Order is kept per raw partition and per graph: one changes partition and one GraphActor per graph, with one commit in flight and at most one commit per (graph, source) per flush.
- Across partitions and sources, results converge by per-path LWW.
- Against humans, `_lock_graph` acquisition order decides. Neither side overwrites the other (shadow merge vs the D2 merge).

### 9. D2 gate with streaming (contract §7 publish/merge step 8; plan 1.3)

When `draft.base_commit_seq < main_head_commit_seq` under the lock, `_window_overlaps` runs:

| Probe | Result |
|---|---|
| (i) Entity overlap with window commits whose `actor_kind <> 'service'` | `NotUpToDate{overlapIds≤50, reason:'people'}` |
| (ii) Structural overlap from any actor: window edges incident to nodes the draft deletes, or containment edges on children the draft re-parents | `NotUpToDate{reason:'structure'}` |
| (iii) Overlap with service commits only | Ids join `_compute_merge_bounded(extra_changed=…)`. Conflict-free: squash with `stats.auto_rebased_from/to` and `service_overlap_count`. Same-field clash: `merge_conflict` with `theirs.sourceName`. |

`require_up_to_date='always'` keeps today's hard gate. A stored legacy value `machine_only` is read as `on_overlap` (X-10).

### 10. Issue lifecycle
- `open → resolved`. Choices: take source (target main or draft) or custom value. It writes a commit with `change_reason='issue:<iid>'`.
- `open → dismissed`. Keep current. Sticky until `theirs_hash` changes; then the issue reopens and `occurrences` increments.
- `open → auto_cleared`. When `ours == theirs` is observed.
- `overridden → acknowledged`.

Kinds are as in contract §4. Envelope-level failures go to `ingest_rejects`, never to issues.

### 11. Lifecycle × ingest (contract §9, X-08)

**Hook.** `versioning/ingest_state.py:on_lifecycle_transition(s, graph_id, from_state, to_state)` (NEW) is called by CONVERSION's `lifecycle_state.transition()` at contract §7 lifecycle step 5, in the same transaction.

| Entering | Effect on sources |
|---|---|
| frozen, trashed, detaching, ready (rollback) | `state IN (active, throttled, blocked, paused_budget)` → `paused`, `state_reason='lifecycle:<to>'`, `state_epoch++`, revision with actor `system:lifecycle` |
| detached (and `release_source` for the binding) | Non-retired sources → `retired` |
| live (unfreeze, restore, cutover) | `state_reason LIKE 'lifecycle:%'` → normal resume (flip + replay). On a retention gap the source stays `paused` with `state_reason='retention_gap'` and a revision. |
| any writable state | Enqueue `ingest_redrive` for open rejects with `stage='held'` and reason `graph_not_writable` |
| purging | Purge deletes the source rows. The router treats them as ignored. |

**Applier classification of `GraphNotWritable.reason`:**
- `cutover_settling`: sleep `retry_after`, then retry.
- Any other reason: hold for up to `INGEST_NOT_WRITABLE_HOLD_SECS=300`, then write held rejects (reason `graph_not_writable`) and advance.

**Activation (and every resume)** requires `lifecycle_state='live'`, `owns_falkor_graph`, `falkor_graph_name IS NOT NULL`, and `writes_open_at ≤ now`. Failures:
- 409 `projection_not_adopted` when `live_legacy`;
- 409 `graph_not_writable` otherwise.

The name prefix is never tested.

### 12. falkordb_snapshot binding (X-07)

**The row.** `decoder='falkordb_snapshot'`, `raw_topics='{}'`, `routing=NULL`, and `decoder_options={provider, sourceGraphName, identityProperty, autoApply}`. The default field policy is `{'*':{'*':'shared'}}`, minus guardrails. At most one non-retired binding per graph.

**Lifecycle.**
- Created from Drift & sync → "Keep in sync with original graph" (SourceWizard steps 3-5).
- Approval: P, with four-eyes when protected.
- Its "dry run" is the latest CONVERSION `drift_scan`. Activation needs a scan newer than 24 h, plus live and owned.

**Shadow seeding on activation.** Seeding is batched, in jobs keyed `seed:<sid>:<state_epoch>`.
- Converted graphs: import-commit rows mapped by `payload_to_source_shape`, with `k=(verified_at(window) ms, mapping_epoch, 0, 0)` and `claimed=false`.
- Adopted graphs: the `gap_scan` baseline.

**Delivery.** `drift_sync` (P, CONVERSION) calls `apply_source_delta(..., principal=Principal.service(sid), delivery='snapshot')`. Each scanned window carries `complete` scope, so retractions stay within the shadow. With `autoApply=false`, every diff becomes an issue and nothing is written to main.

**Release.** `release_source` retires the binding in its own transaction.

### 13. Compaction (D3, contract §10)

**Candidates.** `branch=main ∧ kind='ingest' ∧ actor_kind='service' ∧ created_at < now − ingest_retention_days` (default 14, minimum 7), with `seq < projected_commit_seq` and `seq > last compacted to_seq`.

**Protected seqs**, which close runs:
- every non-ingest main commit;
- every `branches.base_commit_seq` (all statuses);
- `merge_requests.base_commit_seq`;
- fork children's `fork_base_commit_seq` (models.py:94-95);
- pull `stats.from_seq` and `to_seq` (service.py:1166-1167);
- `projected_commit_seq`;
- `base_commit_seq` and `as_of_seq` of non-terminal jobs;
- `graphs.cutover_seq`.

**Skips.** A graph is skipped while any lifecycle, bootstrap, preflight or purge job is pending or running on it.

**Run** = a maximal consecutive set of eligible commits within one UTC day, containing no protected seq. The last commit of a run is kept as the checkpoint.

| Step | Transaction | Work |
|---|---|---|
| A | single | `commit_compactions(status='pruning')` plus delete the non-checkpoint commit rows |
| B…n | chunked | Delete superseded node/edge versions and Merkle rows in (a, b). "Superseded" = a later row for the same key with `seq ≤ b`. |
| check | — | `MerkleStore.root_at(b) == checkpoint.merkle_root`, else abort and page |
| Z | single | `status='done'`, `storage_bytes_est −= reclaimed`, `checkpoint.stats.compacted={commitsRemoved, fromSeq}` |

**Lemma.** For every kept seq c, `_values_at`, `_heads_as_of`, `root_at` and `_as_of_many` are unchanged. Rows before a are untouched. For c ≥ b, the newest row at or before c has seq ≥ s′ > s. Heads are never superseded.

**Locks.** Compaction holds `gvcompact:<gid>` exclusive. Seq pinners hold it shared while validating and registering a seq: restore, revert, export, fork, `history_export`, purge.

**Readers inside (a, b)** get `HistoryCompacted` → 410 `{fromSeq, toSeq, checkpointCommitId}`.

---

## Data model & migrations

All revisions belong to the shared chain (contract §5). INGEST owns no other revision; its former M1-M3 are deleted (X-01, X-02). ORM CHECKs are updated in the same PR as each migration. `test_migrations_*` asserts that live CHECK domains equal the ORM domains.

### Chain revisions INGEST depends on or owns content in

| Rev | Ingest content |
|---|---|
| `20261010_1100_gv_commits_kind_actor` | `ck_commits_kind` += `ingest` (ORM models.py:426-434 updated). `commits.actor_kind TEXT NOT NULL DEFAULT 'human'` with CHECK (human, service, system). `commits.source_id TEXT NULL`. `commits.source_ref JSONB NULL`. Batched backfill: genesis, import and sync become `system`. |
| `20261010_1200_gv_jobs_types` | Full-union `ck_jobs_type` including `ingest_dryrun`, `ingest_replay`, `ingest_redrive`, `compaction` (ORM models.py:349-357, which today lacks `purge`). |
| `20261010_1300_gv_graphs_policy_lifecycle` | INGEST columns: `ingest_guardrails JSONB NOT NULL DEFAULT '{"human_paths":["properties.businessOwner","properties.classification","properties.glossaryTerms"]}'`; `storage_bytes_est BIGINT NOT NULL DEFAULT 0`; `storage_budget_bytes BIGINT NULL` (NULL means `GRAPHVER_DEFAULT_GRAPH_BUDGET_BYTES`); `ingest_retention_days INT NULL CHECK (>=7)`; `storage_state TEXT NOT NULL DEFAULT 'ok'` with CHECK (ok, warn, critical, over). Also `require_up_to_date` (on_overlap, always) and `require_review` as specified there. |
| `20261010_1700_gv_ingest_tables` | All ingest tables below. |
| `20261010_1900_gv_commits_idem_unique` | `uq_commits_idem (graph_id, branch_id, idempotency_key) WHERE idempotency_key IS NOT NULL`, per partition then ATTACH, with a duplicate pre-check. `ix_commits_actor (graph_id, branch_id, actor_kind, commit_seq)`. Drop `ix_commits_idem` (models.py:425). |

### Tables in `20261010_1700` (graphver schema)

**`ingest_sources`** (plain)

| Column | Type / notes |
|---|---|
| `id` | TEXT PK, `isrc_…` |
| `graph_id` | TEXT NOT NULL, FK graphs ON DELETE CASCADE |
| `workspace_id`, `data_source_id`, `name` | |
| `decoder` | CHECK (openlineage, canonical, snapshot, falkordb_snapshot) |
| `decoder_version` | INT |
| `decoder_options` | JSONB |
| `raw_topics` | TEXT[] NOT NULL DEFAULT '{}' |
| `routing` | JSONB NULL: `{job_namespaces[], dataset_namespaces[], adopt_unmatched_datasets}` |
| `urn_strategy` | CHECK (openlineage, datahub, template, identity) |
| `urn_template` | JSONB |
| `type_mapping`, `field_policy`, `delete_policy`, `rate_limit` | JSONB. `delete_policy` default `{max_abs:500, max_pct:5}`. |
| `skew_tolerance_secs` | INT DEFAULT 0 |
| `claim_existing` | BOOL |
| `state` | CHECK (draft, paused, active, blocked, throttled, paused_budget, retired) |
| `state_reason`, `state_epoch BIGINT`, `mapping_epoch INT` | |
| `policy_version` | INT. Kept under this name (X-29). |
| `policy_approved_by`, `policy_approved_at` | |
| `policy_proposed_by` | Proposer of the approved version |
| `policy_self_approved` | BOOL NOT NULL DEFAULT false. Approver equalled proposer; drives the "needs countersign" badge (X-25). |
| `proposed_policy`, `proposed_by`, `proposed_at` | |
| `start_from` | JSONB |
| `shadow_live_count` | BIGINT |
| `last_dryrun_job_id`, `last_dryrun_policy_version` | |
| `created_by`, `created_at`, `updated_at` | |

Constraints and indexes:
- `UNIQUE(graph_id, name)`;
- `ix_isrc_state(state)`;
- `ix_isrc_graph_live(graph_id) WHERE state <> 'retired'`;
- `uq_isrc_binding(graph_id) WHERE decoder='falkordb_snapshot' AND state <> 'retired'`.

**`ingest_source_revisions`** (plain, append-only, no FK so it survives purge)

| Column | Type / notes |
|---|---|
| `id`, `source_id`, `graph_id`, `policy_version` | |
| `action` | CHECK (created, edited, proposed, approved, activated, paused, resumed, blocked, force_deletes, discarded, replay, redrive, retired, budget, retention_gap, seeded) |
| `diff` | JSONB |
| `actor`, `actor_kind`, `reason`, `created_at` | |

Index `(source_id, created_at DESC)`. Rows with action ∈ {approved, activated, blocked, budget, retired, retention_gap} are relayed to the management outbox as `workspace.ingest_source.<action>`, by the same relay that relays CONVERSION's `lifecycle_events`.

**`ingest_source_partitions`** (plain): `source_id`, `topic`, `partition INT`, `state_epoch BIGINT`, `paused_at_offset`, `resumed_at_offset`, `replay_job_id`, `updated_at`. PK `(source_id, topic, partition, state_epoch)`.

**`ingest_offsets`** (plain)

| Column | Type / notes |
|---|---|
| `graph_id`, `source_id`, `origin_topic`, `origin_partition` | PK (all four) |
| `last_offset` | BIGINT. Upsert uses `GREATEST`. |
| `last_event_time` | |
| `applied_envelopes`, `noop_envelopes`, `fenced_envelopes`, `quarantined_envelopes`, `held_envelopes` | BIGINT counters |
| `last_commit_seq`, `updated_at` | |

**`ingest_run_state`** (plain, fillfactor 70): `graph_id`, `source_id`, `job_entity_id`, `run_id`, `state`, `event_time`, `nominal_time`, `error_message` (truncated to 1 KB), `duration_ms`, `updated_at`. PK `(graph_id, source_id, job_entity_id)`.

**`ingest_rejects`** (plain; `graph_id` is nullable for decode and route failures)

| Column | Type / notes |
|---|---|
| `id`, `source_id`, `graph_id` | |
| `stage` | CHECK (decode, route, apply, held) |
| `reason` | Includes `graph_not_writable`, `source_paused`, `source_blocked`, `source_paused_budget`, `policy_changed`, `breaker`, `poison`, `unsupported_envelope_version`, `event_too_old`, `retention_gap` |
| `origin_topic`, `origin_partition`, `origin_offset`, `event_time`, `envelope_version`, `decoder_version` | |
| `payload` | BYTEA (zstd, ≤ 1 MB) or `payload_uri` |
| `force_token` | |
| `status` | CHECK (open, redriving, redriven, discarded) |
| `redrive_job_id`, `created_at`, `updated_at` | |

Indexes `(source_id, status, created_at)` and `(graph_id, status, stage, reason)`.

**`commit_compactions`** (plain)

| Column | Type / notes |
|---|---|
| `id`, `graph_id`, `branch_id` | |
| `from_seq` | Exclusive lower bound |
| `to_seq` | The checkpoint seq |
| `checkpoint_commit_id`, `day` | |
| `commits_removed`, `versions_removed`, `merkle_removed`, `bytes_reclaimed_est` | |
| `source_refs` | JSONB: merged origin ranges |
| `status` | CHECK (planned, pruning, done). `planned` is report mode. |
| `created_at`, `completed_at` | |

`UNIQUE(graph_id, branch_id, from_seq)`; index `(graph_id, branch_id, to_seq)`.

**`source_assertions`** (HASH-partitioned on graph_id; added to `PARTITIONED_TABLES`, models.py:45; children created with the modulus used by models.py:611; fillfactor 80)

| Column | Type / notes |
|---|---|
| `graph_id`, `source_id`, `entity_id` | PK (all three) |
| `entity_kind` | CHECK (node, edge) |
| `urn`, `entity_type`, `src_entity_id`, `tgt_entity_id`, `edge_type` | |
| `payload`, `content_hash` | |
| `path_times` | JSONB |
| `asserted_k`, `retracted_k` | |
| `is_tombstone`, `claimed` | BOOL |
| `first_seen_seq`, `last_changed_seq`, `updated_at` | |

Partial indexes `WHERE entity_kind='edge' AND NOT is_tombstone`:
- `ix_sa_src (graph_id, source_id, src_entity_id, edge_type)`;
- `ix_sa_tgt (graph_id, source_id, tgt_entity_id, edge_type)`.

**`ingest_issues`** (HASH-partitioned; added to `PARTITIONED_TABLES`)

| Column | Type / notes |
|---|---|
| `graph_id`, `id` | PK |
| `source_id` | |
| `kind` | CHECK per contract §4 |
| `entity_id` | NOT NULL |
| `entity_kind`, `path TEXT[]` | |
| `path_key` | NOT NULL DEFAULT '' |
| `base`, `ours`, `theirs`, `ours_hash`, `theirs_hash`, `detail` | |
| `status` | CHECK (open, resolved, dismissed, auto_cleared, acknowledged) |
| `occurrences`, `first_seen_seq`, `last_seen_seq`, `first_seen_at`, `last_seen_at` | |
| `resolved_by`, `resolved_at`, `resolution` | |

`uq_issue_open (graph_id, source_id, kind, entity_id, path_key) WHERE status IN ('open','dismissed')`; `ix_issue_inbox (graph_id, status, kind, last_seen_at DESC)`.

### No-schema changes

- **Version rows.** `_write_deltas` (service.py:5703) gains a `change_reason` parameter, written instead of the `None` at lines 5720 and 5730: `ingest:<sid>`, `issue:<iid>` or `sync:<sid>`.
- **Ontology** (`backend/app/ontology/system_ontology.json`). CONTAINS gains source `dataset` and targets `schemaField` and `column`; this ships in S0 (X-30). The OpenLineage decoder synthesises a `dataFlow` per job namespace, because `dataJob` is only containable by dataFlow, pipeline or schema.
- **Management DB.** Migration `20261010_1000_datasource_publish` (ACCESS R0).

### Kafka
- `graphver.changes`: 64 partitions, RF 3, `min.insync.replicas=2`, zstd, retention 7 d, `max.message.bytes=8 MB`, key = graph_id.
- Raw topics must keep at least 7 d.
- Consumer groups `gv-ingest-router` and `gv-ingest-applier`: manual commit, static `group_instance_id` = pod name.

---

## API

**New router.** `backend/app/api/v1/endpoints/ingest.py`, mounted like versioning (api.py:373): prefix `/{ws_id}/versioning`, `Depends(versioning_write_gate)`.

**Common to every route:**
- `graph_in_workspace` (versioning.py:408). A graph or source the caller cannot read returns 404.
- Errors go through the shared `_domain_errors` (versioning.py:458), driven by `versioning/errors.py` (X-03).
- Optimistic concurrency uses body fields. If-Match is not used.

**Write-gate allowlist.** `versioning_gate._WRITE_ALLOWLIST_SUFFIXES` (versioning_gate.py:33, matched with `endswith` at line 61) becomes a regex list that includes `/ingest/sources/[^/]+/pause$`.

| Method & path | Action | Request → response | Errors |
|---|---|---|---|
| GET `/graphs/{gid}/ingest/sources` | R | → `[{id, name, decoder, state, stateReason, policyVersion, pendingPolicy, needsCountersign, lag:{events, seconds}, lastCommitAt, openIssues, access}]`. Implicit `snapshot` rows are hidden. | 404 |
| POST `/graphs/{gid}/ingest/sources` | INGEST_CREATE (M) | `{name, decoder∈{openlineage, canonical}, decoderOptions, rawTopics, routing, urnStrategy, urnTemplate?, typeMapping, fieldPolicy?, deletePolicy?, rateLimit?, claimExisting?}` → 201, the source in `draft`, `policyVersion:1`, unapproved | 422 `invalid_source_config{problems[]}` (including `name_exists`), 422 `policy_violates_guardrail`, 422 `ontology_containment_missing{from, to, edgeType}`, 409 `routing_overlap{otherSourceId, prefixes}`, 409 `graph_not_writable` |
| POST `/graphs/{gid}/ingest/bindings/falkordb-snapshot` | INGEST_CREATE (M) | `{fieldPolicy?, deletePolicy?, autoApply}` → 201 binding in `draft` (X-07). The provider, `sourceGraphName` and `identityProperty` come from the graph. | 409 `source_state` (a binding exists), 409 `graph_not_writable`, 422 as above |
| GET `/graphs/{gid}/ingest/sources/{sid}` | R | → full config, `stateEpoch`, `mappingEpoch`, approver, proposed policy and diff, per-partition offsets and lag, last dry-run summary, `access` | 404 |
| PATCH `/graphs/{gid}/ingest/sources/{sid}` | INGEST_CREATE (M) | `{expectedPolicyVersion, …fields}`. `name`, a lowered `rateLimit` and `skewToleranceSecs` apply immediately. Envelope fields are edited in place in `draft`, otherwise stored as `proposed_policy` → 202 `{pendingApproval:true}`. | 409 `version_conflict{resource:'ingest_policy', currentVersion}`, 409 `source_state{state:'retired'}`, 422 as for create |
| POST `…/{sid}/policy/approve` | INGEST_APPROVE (P, four-eyes) | `{expectedPolicyVersion, note?}` → `{policyVersion, mappingEpoch, replaySuggested}` | 403 `access_denied{code:'self_approval_forbidden'}`, 409 `source_state{detail:'nothing_pending'}`, 409 `version_conflict`, 409 `dryrun_required` (no dry run for the proposed policy within 7 d; for a binding, no `drift_scan` within 24 h) |
| POST `…/{sid}/dry-run` | INGEST_CREATE (M) | `{maxEvents=5000, sinceHours=24}` → 202 `{jobId}`. Job `ingest_dryrun`, key `dryrun:<sid>:<policy_version>:<hour>`. | 409 `source_state` (binding: use drift scan) |
| GET `…/{sid}/dry-run/{jobId}` | INGEST_CREATE (M) | → `{status, progress, report:{eventsSampled, decodeErrors[], unroutable, ignored, entities:{matchedByUrn, matchedByAltUrn, matchedByQname, ambiguous[], new}, edges:{matched, new, foreignEndpoint}, firstContact:{absentFieldsSet, sourcePathsOverwritten, sourcePathsOverwrittenHumanAuthored}, ontologyViolations[], claimPreview, breakerWouldTrip, estimates:{commitsPerDay, changedEntitiesPerDay, bytesPerDay, budgetPctAfter30d}}, reportUri}` | 404 |
| POST `…/{sid}/activate` | INGEST_ACTIVATE (P) | `{startFrom:'latest'\|'earliest'\|{timestamp}, claimExisting?}` → source in `paused` | 409 `graph_not_writable`, 409 `projection_not_adopted`, 409 `policy_unapproved`, 409 `dryrun_required`, 409 `routing_overlap`, 409 `source_state` |
| POST `…/{sid}/resume` | INGEST_RESUME (P) | `{acceptGap?}` → `{replayJobId}` | 409 `graph_not_writable`, 409 `projection_not_adopted`, 409 `retention_gap{partitions[]}`, 409 `source_state{state:'paused_budget', reason:'storage_over'}`, 409 `replay_in_progress` |
| POST `…/{sid}/pause` | INGEST_PAUSE (M) | `{reason}` → 200, idempotent. Allowed when the versioning flag is off. | 409 `source_state{state:'retired'}` |
| POST `…/{sid}/confirm-deletes` | INGEST_ACTIVATE (P) | `{batchToken, decision:'apply'\|'discard'}` → `{deletes, sample[50], humanTouched}` | 409 `source_state{detail:'not_blocked'\|'token_mismatch'}`, 409 `graph_not_writable` |
| POST `…/{sid}/replay` | INGEST_REPLAY (P) | `{from:{timestamp}\|{offsets[]}, to?, reason}` plus an `Idempotency-Key` header → 202 `{jobId}`. Job key `replay:<sid>:<state_epoch>:<key\|uuid>`. A single active replay is checked under `ingest_sources FOR UPDATE` (X-16). | 409 `replay_in_progress`, 409 `retention_gap`, 409 `graph_not_writable` |
| POST `…/{sid}/retire` | INGEST_ACTIVATE (P) | `{reason}` → 200. Requires `DangerConfirmDialog` in the UI. | 409 `source_state` |
| GET `…/{sid}/revisions?before&limit` | R | → keyset-paged revisions | |
| GET `/graphs/{gid}/ingest/status` | R | → `{sources:[{id, state, applyLagSeconds, applyLagEnvelopes, routerLagRecords, eventsPerMin[60], commitsPerHour, lastCommitSeq, lastCommitAt, lockWaitP95Ms, quarantined24h, heldOpen}], projection:{lagCommits, lagSeconds, route}, storage:{…}}`. Postgres plus the worker heartbeat registry (fleet.py:126 pattern). | |
| GET `/graphs/{gid}/ingest/issues?status&kind&sourceId&entityId&before&limit≤200` | R | → `{items:[{id, kind, sourceId, sourceName, entityId, entityType, displayName, path, base, ours, theirs, oursHash, theirsHash, occurrences, firstSeenAt, lastSeenAt, status, detail}], nextBefore, counts:{byKind}}`, keyset on `(last_seen_at, id)` | 422 (bad cursor) |
| POST `/graphs/{gid}/ingest/issues/{iid}/resolve` | See the table below | `{choice:'source'\|'current'\|'value', value?, target:'main'\|'draft', draftBranchId?, expectedOursHash, bypass?:{reason}}` → `{status, commitId?}` | 409 `version_conflict{resource:'ingest_issue', currentVersion:oursHash}`, 409 `review_required{canStageToDraft:true}`, 409 `merge_conflict`, 409 `branch_closed`, 409 `graph_not_writable`, 403 `access_denied`, 404 (draft), 422 `ontology_violation`, 422 `bypass_reason_required` |
| POST `/graphs/{gid}/ingest/issues/bulk` | Same as single resolve, per choice | `{ids[≤1000] \| filter, choice, target, draftBranchId?}` → per-id outcomes. One commit per target. | same |
| POST `/graphs/{gid}/ingest/issues/{iid}/acknowledge` | INGEST_ISSUE_DISMISS (M) | → 200 (`overridden` receipts) | |
| GET `/graphs/{gid}/ingest/rejects?stage&sourceId&reason&status&before&limit` | INGEST_CREATE (M) | → items with a 4 KB payload preview. Route-stage rows are listed via `sourceId`. | |
| POST `/graphs/{gid}/ingest/rejects/redrive` | INGEST_REJECT_ADMIN (P) | `{ids[] \| filter}` → 202 `{jobId}`, key `redrive:<sid>:<uuid>` | 409 `graph_not_writable`, 409 `job_active` |
| POST `/graphs/{gid}/ingest/rejects/discard` | INGEST_REJECT_ADMIN (P) | `{ids[] \| filter, reason}` → `{discarded}`; a revision is written | |
| GET `/graphs/{gid}/ingest/entities/{eid}/sources` | R | → `[{sourceId, sourceName, decoder, state, managedPaths:[{path, ownership}], lastAssertedAt, retracted}]`. One PK lookup per non-retired source. | |
| GET `/graphs/{gid}/storage` | R | → `{bytesEst, budgetBytes, pct, state, retentionDays, compaction:{mode, lastRunAt, rangesDone, backlogDays, bytesReclaimed30d}}` | |
| PATCH `/graphs/{gid}/storage` | STORAGE_EDIT (A) | `{storageBudgetBytes?, ingestRetentionDays? (≥7)}` → the storage object | 422 (validation), 409 `version_conflict` not used (last write wins; audited in access_events as policy) |

**Issue resolve authorization (X-05):**

| Choice and target | Requirement | Commit written |
|---|---|---|
| `current` | M | None |
| `source` → main | P on any graph | `apply_ops_detailed(…, principal=human, allow_main=True, main_action=INGEST_ISSUE_RESOLVE_MAIN)`. Kind `edit`, actor_kind `human`, `change_reason='issue:<iid>'`. |
| `value` → main | `MAIN_WRITE_THROUGH`: P and not protected; otherwise 409 `review_required{canStageToDraft:true}` or a valid bypass (writes access_events `main.write_through` with decision `bypassed`) | Same as above |
| any → draft | `DRAFT_WRITE` on `draftBranchId`. The draft must be open and on the same graph; draft-write gate order applies. | Draft commit |

**Changed existing endpoints:**
1. GET `/graphs/{gid}/commits` (versioning.py:2191).
   - Adds `actorKinds` (default for the published view: human,system) and a `beforeSeq` keyset.
   - Rows gain `actorKind`, `sourceId`, `sourceName` and `compacted{commitsRemoved, fromSeq}`.
   - The response gains `automatedSince{count, sources[]}`.
2. GET `…/entities/{eid}/history` (versioning.py:2135): `actorKinds`; rows gain `actorKind`, `sourceName` and `compacted`.
3. GET `…/entities/{eid}/summary` (versioning.py:2167): adds `lastHumanEdit` and `lastSourceUpdate`.
4. GET `…/branches/{bid}/freshness` (versioning.py:1932): adds `behindByPeople`, `behindByAutomation` and `overlapsMyEdits`, cached per (branch head, main head) for 5 s.
5. Publish (versioning.py:1766) and PR/MR merge (versioning.py:3357 and 3585): 409 `not_up_to_date{overlapIds≤50, reason}`, and 409 `merge_conflict{conflicts[], theirs.sourceName}`.
6. Every as-of, diff, revert, restore, restore-preview, export and state-at-commit path returns 410 `history_compacted{fromSeq, toSeq, checkpointCommitId}`.
7. POST `/graphs/{gid}/sync` (versioning.py:2530). Authorization is `MAIN_SYNC` (ACCESS). Its commits are kind `sync`, actor `system:sync`, `source_ref.requested_by` = the human.

**`errors.py` classes used by INGEST:**
- `GraphNotWritable` → 409;
- `LockBusy`, `ContentionExhausted` → 503 `lock_busy` with Retry-After;
- `ReviewRequired` → 409;
- `VersionConflict` → 409;
- `SourceStateError` → 409 `source_state{state, detail?}`;
- `RetentionGap`, `RoutingOverlap`, `DryrunRequired`, `PolicyUnapproved`, `ReplayInProgress`, `ProjectionNotAdopted` → their 409 codes;
- `HistoryCompacted` → 410;
- `DanglingReference(OntologyViolation)` → 422 `ontology_violation`;
- `InvalidSourceConfig`, `PolicyViolatesGuardrail`, `OntologyContainmentMissing` → 422;
- `ServicePrincipalForbidden` → 403.

Subclasses are matched before `ConcurrencyError` (versioning.py:480).

---

## Enforcement points (file:function → change)

**backend/app/services/versioning/service.py**
- **`_lock_graph` (5370).** Add `lock_timeout_ms` and `statement_timeout_ms`, issued as `SET LOCAL` before `pg_advisory_xact_lock`. Map 55P03 and 57014 to `LockBusy`. The ingest path uses 1000/30000.
- **`_retry_seq` (5351).**
  - Catch `LockBusy` as well.
  - Use full-jitter backoff `rand(0, 0.02·2ⁿ)`, capped at 2 s.
  - Raise `ContentionExhausted` instead of the bare `ConcurrencyError`.
  - Shared with plan 0.4.
- **`_assert_not_bootstrapping` (466).** Superseded by CONVERSION's `_assert_writable`, which raises `GraphNotWritable(state, reason, retryable, retry_after)`. Ingest calls `_assert_writable`.
- **`_apply_ops_once` (5420).**
  - Extract the tail (about 5496-5609) verbatim into `_commit_values(s, graph, branch, new_vals, cur_vals, kind_by_entity, *, kind, message, actor, actor_kind, source_id=None, source_ref=None, idempotency_key=None, change_reason=None, on_invalid='reject', containment_edge_types, ontology_rules, edited) -> CommitOutcome`.
  - `_apply_ops_once` calls it with `kind='edit'`. Existing write-through suites must pass unchanged.
  - Inside it, `graph.storage_bytes_est += est`, on the row already touched at line 5603.
  - Replace `raise ConcurrencyError("edge … would dangle")` (line 5546) with `DanglingReference`.
- **`_enforce_written` (3016).** Add `collect=True`, which returns violations instead of raising. With `on_invalid='quarantine'`, `_commit_values` drops the attributed ids and their incident edges and re-checks at most twice. An unattributable violation raises `UnattributableViolation`, and the applier bisects.
- **`_write_deltas` (5703).** Add a `change_reason` parameter (lines 5720 and 5730).
- **NEW `apply_source_delta(graph_id, *, principal, source, envelopes, delivery, containment_edge_types, ontology_rules, force_deletes_token=None) -> SourceApplyResult`.**
  - Asserts `principal == Principal.service(source.id)` and `delivery ∈ {live, replay, redrive, snapshot}`.
  - Wraps `_apply_source_once` in `_retry_seq`.
  - `_apply_source_once` follows the contract §7 ingest order:
    1. `_lock_graph(1000)`;
    2. `_assert_writable`;
    3. `ingest_sources FOR SHARE` then `access.decide(INGEST_APPLY)` (HOLD per Concepts §4);
    4. `_fence_offsets` (`ingest_offsets FOR UPDATE`, live only);
    5. `_lww_fold`;
    6. `_resolve_identities`;
    7. `_load_shadow`, `_head_values`, `_merge_source_entity`, `_claim_anchor`, `_expand_scopes`, `_govern_deletes`;
    8. `_commit_values(kind='ingest', actor='svc:ingest:'+sid, actor_kind='service', source_id, source_ref={policy_version, approved_by, mapping_epoch, decoder, delivery, origin_ranges, run_ids[≤10], counts}, change_reason='ingest:'+sid, on_invalid='quarantine')`;
    9. `_upsert_shadow`, `_upsert_run_state`, `_upsert_issues`, and the `ingest_offsets` GREATEST upsert plus counters.
  - Lock order (contract §8): advisory lock, then `graphs` (plain UPDATE), then `projection_state`, then `ingest_sources`, then `ingest_offsets`.
  - Added to `test_service_signatures`.
- **NEW `_heads_by_urn_all`, and `_heads_by_edge_triple_all(…, live_only=True)`** next to 5224 and 5243 (list-valued). The sync and ingest callers use them.
- **NEW `versioning/identity.py`:**
  - `mint_sync_edge_id` replaces the two inline `sync:e:` f-strings (5214, 5345);
  - `mint_import_edge_id` (CONVERSION);
  - `node_eid_for_urn`, `synthetic_node`.
- **`publish` (882; gate at 929) and `merge_mr` (2072; gate at 2118); same change in `merge_pr`.** Replace `if draft.base_commit_seq < graph.main_head_commit_seq: raise NotUpToDate` with `_window_overlaps(s, gid, main_id, base, head, draft)`. Its entity probe uses `ix_commits_actor` with `actor_kind <> 'service'`; the structural probe covers all actors. Service-only ids are passed as `extra_changed`. Keep `always` behaviour when `graphs.require_up_to_date='always'`.
- **`_compute_merge_bounded` (4633).**
  - Add `extra_changed`.
  - Remove the window union at 4653: `changed = own ∪ resolutions ∪ extra_changed`.
  - Fix the stale comment at about 4655.
- **`sync_ingest` (4982):**
  - Implicit source row `decoder='snapshot'`, `state='active'`, created on first sync per source name.
  - Merge base = the shadow.
  - Deletion candidates = live shadow ids minus seen ids, replacing `_live_ids_absent_from` (5268).
  - Discard comparisons use the shadow hash.
  - Resolutions go through `_settle_conflicts` (6450).
  - Commits: kind `sync`, actor `system:sync`.
  - `_lock_graph` plus `_retry_seq`.
  - Edges go through `_heads_by_edge_triple_all`.
- **`commit_log` (3454) and `_commit_meta` (3443):** `actor_kinds`, `automated_since`, `actor_kind`, `source_id`, `stats.compacted`. **`branch_freshness` (4321):** the people/automation/overlap split.
- **NEW `_assert_seq_exact(s, gid, bid, seq)`.** Takes `gvcompact` shared and looks up `commit_compactions` (`from_seq < seq < to_seq`). Raises `HistoryCompacted`. Called by:
  - `diff_commits` (3521), `state_at_commit` (2215), `materialize_state(as_of)`;
  - `restore_to_commit` (1464), restore-preview, `revert_commit` (1351);
  - trace and neighbors `as_of`, and export `as_of`.
- **`_payloads_by_content_hash` (5676).** If an OCC token is unresolvable and differs from the head, raise `MergeConflict(kind='stale_base')`.

**backend/app/services/versioning/ (other files)**
- **`merge.py:three_way_merge` (91):** keyword `keyed: Mapping[str, str]` plus `_merge_keyed_list`. No behaviour change when it is empty.
- **NEW `source_policy.py`** (pure): `resolve(field_policy, guardrails, set_fields) -> Policy`, `Policy.ownership/set_paths/keyed`, `validate_policy()`. It also checks ontology containment against the assigned `OntologyRules` and returns `ontology_containment_missing`.
- **NEW `ingest_state.py`:** `on_lifecycle_transition`, `transition_source(s, src, to, *, principal, reason)` (bumps the epoch and writes the revision), `enqueue_redrive_held(s, gid, reasons)`.
- **NEW `compaction.py`:** `CompactionRunner`.
  - Claims `compaction` jobs keyed `compact:<gid>:<day>` with `FOR UPDATE SKIP LOCKED` (the import_export/runner.py:40 `claim_one` pattern).
  - Builds the protected set, runs txn A/B/Z and the root check.
  - `GRAPHVER_COMPACTION_MODE ∈ {report, enforce}`.
  - Rate limited by `GRAPHVER_COMPACTION_ROWS_PER_SEC`, pausing when replica lag exceeds 10 s.
- **`worker.py:run` (160).** Behind `VERSIONING_WORKER_ROLES` role `compaction`, add:
  - `_compaction_loop` (leader via `pg_try_advisory_lock('gvcompaction:leader')`, nightly at 02:07 UTC);
  - `_storage_guard_loop` (every 10 min; the only writer of `storage_state`: warn ≥ 80%, critical ≥ 100% → throttled, over ≥ 120% → paused_budget, recovery below 90%);
  - `_ingest_retention_loop` (rejects with status redriven/discarded after 30 d; issues resolved/auto_cleared after 90 d; shadow tombstones older than `INGEST_EVENT_MAX_AGE_DAYS`).
- **`projection.py:_project_graph_locked` (447).** If `not owns_falkor_graph` and the window holds a `kind='ingest'` commit: `last_error='ingest_requires_platform_key'`, do not advance, alert.
- **`purge_worker.py`:**
  - `_BULK` (65) += `source_assertions`, `ingest_issues` (chunked).
  - `_phase_meta` (365) += `ingest_offsets`, `ingest_run_state`, `ingest_rejects WHERE graph_id=:g`, `ingest_source_partitions` (by source ids), `commit_compactions`, then `ingest_sources` last. Revisions are kept.
  - `_phase_quiesce` cancels `ingest_*` and `compaction` jobs (X-14).
- **`messaging.py:nudge_projection` (67).** `SET gvproj:nudge:{gid} NX PX 2000` before XADD, plus `MAXLEN ~100000`.

**Other backend files**
- **`backend/app/services/projection_target.py:after_projection` (159).** Debounce per data source (30 s). One aggregated activity row per view per 15 min for service commits.
- **`backend/app/services/context_engine.py:160`.** Apply X-24 order:
  1. `read_routes()`;
  2. if the route is projection and liveness is ok, `svc.read_route(graph, actor)` with service-only lag ≤ 500 commits and ≤ 15 s;
  3. overlay.
  
  `projection_watermark.fresh` is used only for UI display.
- **NEW `backend/app/services/ingest/`:**
  - `__main__.py`: `INGEST_ROLE ∈ {router, applier, jobs}`, SIGTERM drain, metrics on :8095.
  - `feed.py`: aiokafka plus InMemoryFeed.
  - `envelope.py` and its JSON schema.
  - `decoders/{base, openlineage, canonical, falkordb_snapshot}`. falkordb_snapshot reuses `entity_serde.normalize_source`.
  - `router.py`, `applier.py` (GraphActor, PartitionTracker, ShadowHashCache, the `GraphNotWritable.reason` classification, backpressure via `fleet.claim_decision` at fleet.py:104).
  - `classify.py`, `bisect.py`.
  - `jobs.py`: claims `ingest_dryrun`, `ingest_replay` and `ingest_redrive`. Re-authorizes from `summary.principal` before producing replay or redrive envelopes.
  - `rules_cache.py` (the `_live_containment_types` pattern at versioning.py:490), `dryrun.py`.
  - The applier pauses all changes partitions when `ingestApplyEnabled` OR `versioningEnabled` is off (checked every 30 s).
- **`api/v1/api.py:373`:** include `ingest.router`.
- **`versioning_gate.py:33`:** regex allowlist.
- **`versioning/access.py`:** the actions, `explain` composition and `Action.audit_sink='ingest'` (X-13: never writes access_events).
- **`config.py`:** the INGEST_*, GRAPHVER_COMPACTION_* and budget settings listed in the prior draft. Defaults: budget 2 GiB, fleet 500 GiB, retention 14 d, minimum 7.
- **Deploy:**
  - `deploy/k8s/base/services/ingest-worker/` (StatefulSet, PDB, metrics service, KEDA on applier lag 4-16);
  - `deploy/helm/dataviz/templates/ingest-worker.yaml`;
  - `versioning-worker.yaml` gains the `compaction` role;
  - docker-compose `ingest-worker`; docker-compose.test Redpanda;
  - `requirements.txt` aiokafka.

---

## UI

All UI is built from `frontend/src/components/ui` (`Tabs`, `Badge`, `Button`, `EmptyState`, `Skeleton`, `Segmented`, `TablePagination`, `Sparkline`, `ProgressBar`, `HoverTip`, `TimeStamp`, `UserAvatar`) plus `DangerConfirmDialog`, `ConflictResolver` (with `sideLabels`) and `SubjectPicker`. Copy for every error code lives in `features/versioning/model/accessCopy.ts`. Buttons follow `resource.access.can`, and disabled buttons show `HoverTip` with the `reasons` text.

The layout is placed in the contract §16 hub (`DataSourceVersioningTab`).

**Ingest sub-tab** (`features/ingest/components/IngestPanel.tsx`). One card per source:
- name and decoder badge;
- state badge with these tones: active = success, paused = neutral, throttled = warning, blocked or paused_budget = danger, retired = muted, draft = info;
- `stateReason` text, for example "Paused because the graph is frozen" or "Paused: storage over budget";
- events/min `Sparkline`, lag, last commit `TimeStamp`;
- open-issue chip linking to the inbox;
- "policy v3 · approved by <UserAvatar>", plus a "needs countersign" `Badge` when `needsCountersign`.

Card actions: Pause, Resume, Replay, Edit, Retire.

| State | What the panel shows |
|---|---|
| Loading | Three `Skeleton` cards |
| Empty | `EmptyState`: "No ingest sources yet". Action: "Connect a source" (shown if `access.can.create`). |
| Error | Inline error with Retry |
| Blocked | Danger banner "airflow-prod wants to delete 1,240 entities (limit 500)" → DeleteReview |
| Pending policy | Info banner with a diff table, and Approve / Reject |
| Projection not adopted | Activation disabled. Link "Move to a platform-managed copy" (lifecycle/adopt). |
| Graph not writable | Actions disabled with the lifecycle reason |
| Retention gap | Resume dialog with an "Accept gap" checkbox |

**DeleteReview.** `DangerConfirmDialog` with the source name typed to confirm. Shows the count, a sample of 50, and the human-touched count (those become conflicts). Buttons: "Apply deletions" / "Discard held changes".

**SourceWizard** (`features/ingest/components/SourceWizard.tsx`). A five-step modal with a `ProgressBar`:
1. **Connect.** Decoder `Segmented` (OpenLineage / Canonical), topics, namespace prefixes. A 409 `routing_overlap` shows inline.
2. **Mapping.** Type table, URN strategy, containment edge type. 422 `ontology_containment_missing` shows inline per row with a fix hint.
3. **Field ownership.** Entity type × path `Segmented` (Source wins / Shared / People only / Set merge). Guardrail rows are locked to "People only". Delete limits. A claim-existing toggle.
4. **Dry run.** Progress, then the match stats and four tables (ambiguous identities, first-contact effects, ontology violations, claim preview). Estimates are shown against the budget. A failing dry run blocks Next.
5. **Activate.** Start position, and the line "Starts paused. Nothing is written until you Resume." A `DangerConfirmDialog` appears if human-authored overwrites are predicted.

Drift & sync → "Keep in sync with original graph" reuses steps 3-5. Step 4 shows the latest drift scan, and "Run drift scan" if it is older than 24 h.

**IssuesInbox** (the only inbox; also deep-linked from the canvas).
- Tabs with counts: Disagreements (conflict, placement) | Deletions (delete_modify) | Invalid (invalid, out_of_scope) | Identity (ambiguous_identity, foreign_endpoint) | Receipts (overridden).
- A virtualized keyset list with source, type and search filters.
- `ConflictResolver` with `sideLabels={ours:'Current', theirs:'From <source>', base:'Last from source'}`.
- Primary actions: "Take source" (main) and "Stage into my draft" (draft picker). "Custom value" is allowed on main only if `access.can.writeThrough`; otherwise "Stage into my draft" is the primary action.
- Bulk actions: "Keep current" and "Take source".

| State | What the inbox shows |
|---|---|
| Empty | `EmptyState` "All caught up" |
| Loading | `Skeleton` rows |
| Error | Retry |
| Conflict (409 `version_conflict` / `merge_conflict`) | Amber row "This changed since you opened it", with Reload. Picks are kept. |
| 409 `review_required` | Toast with "Stage into my draft instead" |

**Data health sub-tab.**
- **Storage card.** `ProgressBar` with tones at warn, critical and over; retention; compaction mode, last run, backlog and bytes reclaimed in 30 d. Admins can edit budget and retention (minimum 7). A banner when throttled or paused for budget.
- **RejectsTable.** Stage, reason, origin, event time, decoder version, an expandable payload preview, Redrive and Discard (bulk by filter), `TablePagination`. Empty: "No rejected events".

**Review & protection** (ACCESS `ProtectionSettingsPanel`). INGEST contributes:
- `GuardrailsEditor`: a list of `human_paths`, edited via PATCH `/graphs/{gid}/policy` `ingestGuardrails` (A);
- a "Self-approved sources" list from `selfApprovedSources`;
- the two-option up-to-date `Segmented`.

**History sub-tab.**
- Changes: `Segmented` People (default) / Automation / All. Automation collapses to "1,240 automated updates from 2 sources · 09:00–11:30" (expandable). Compacted rows read "Daily checkpoint · 3,410 automated commits compacted".
- Source changes list: `ingest_source_revisions`.
- `CommitRow`: a source badge and a Compacted badge.
- `EntityHistory`: the same filter, a "Last human edit / Last source update" header, and a 410 message with links to the nearest checkpoints.

**Entity editors.** `SourceManagedChip`:

| Ownership | Chip |
|---|---|
| Source-owned | "Managed by OpenLineage · airflow-prod", with a hover explanation |
| Shared | "Also set by …", plus "Source says: Y" |
| Retracted but kept | "Removed upstream · kept" |

**Canvas.** `useActiveBranchGuard` plus `CanvasVersioningBar` handle `graph_not_writable`, `cutover_settling` (auto-retry), `review_required`, `branch_closed` and `main_write_forbidden`.
- `PullBeforeMergeBanner` shows only if `overlapsMyEdits > 0 || behindByPeople > 0`.
- A passive "Sources updating · 12 changes" chip.
- Freshness polling backs off from 15 s to 60 s while only automation advances.

Merge 409s:
- `people`: list the overlapping entities, with a Pull CTA.
- `structure`: "Someone changed what you deleted or moved".
- Source `merge_conflict`: ConflictResolver labelled with the source name.

---

## Failure modes & recovery

| Failure | Behaviour | Recovery |
|---|---|---|
| Router crashes after produce, before the raw commit | Duplicates land after their originals (Lemma 1) and are fenced | None; the audit balances |
| Decode error | Reject with stage `decode`; offset advances | Fix the decoder or mapping, then redrive (re-decode) or discard (P) |
| Applier crashes inside the transaction | Rollback; the advisory lock is released; redelivered | None |
| Applier crashes after PG COMMIT, before the Kafka commit | Redelivered with o ≤ L; fenced | None |
| Zombie applier after a rebalance | `_lock_graph` serialises; the loser re-reads L and is fenced; the cache token drops its stale cache | None |
| `LockBusy` behind a long publish | Jittered retry, then actor backoff 50 ms to 30 s; other graphs keep flowing | Alert when lock-wait p95 exceeds 2 s for 10 min |
| `graph_not_writable` with `cutover_settling` | Sleep `retry_after`, retry | Automatic |
| `graph_not_writable`, other reasons (frozen, trashed, converting, detaching, purging) | Hold 300 s, then held rejects (reason `graph_not_writable`). The lifecycle hook has already paused the sources, so later envelopes are also held. | A transition to a writable state auto-enqueues redrive. Purge deletes the rows. |
| Envelope for a source that is paused, blocked or paused_budget | Held (reason `source_<state>`) | Resume or confirm-deletes auto-redrives |
| Policy approved while envelopes are in flight | Held (`policy_changed`) | The redrive re-decodes from Kafka by origin coordinates. Past retention, the reject stays open; then replay or accept. |
| Invalid entity, dangling edge, second parent | Quarantine with `invalid` issues; the rest commits; the shadow does not advance for them. An unattributable violation is bisected to one `poison` reject. | Correct upstream; the next event re-applies |
| Mass delete above the breaker | Nothing applied; `blocked`; held | DeleteReview: apply (P) or discard |
| Late or out-of-order event | LWW drops it (`gv_ingest_stale_dropped_total`); an older complete scope is skipped | None |
| Late conflicting event within R after an actor restart | Possible mis-order; `gv_ingest_late_applied_total` | Converges on the next assertion; set R=0 if non-zero matters |
| Event older than `INGEST_EVENT_MAX_AGE_DAYS` | Reject `event_too_old` | Replay with review |
| Source paused past Kafka retention | 409 `retention_gap`; gauge alert 24 h ahead | `acceptGap`, then a provider resync. A lifecycle auto-resume leaves the source paused with `retention_gap`. |
| Kafka down | Backoff; partitions pause when the buffer is full | Within 7 d retention: none |
| PG failover | Transient retry; no partial writes | None |
| Projection lags | `read_route` serves FalkorDB within 500 commits / 15 s; beyond 5 min of lag, actors double the flush window up to 60 s | Alert at projection lag p95 > 60 s |
| Projector targets a non-owned key with ingest pending | Refuses (`ingest_requires_platform_key`) | `lifecycle/adopt` |
| External writer keeps writing the original key | No invariant broken; CONVERSION `drift_scan` raises the SourceGraphCard alert | "Keep in sync with original graph" (binding) or onboard the writer as a Kafka source |
| Publish clashes with a stream on the same field | `merge_conflict` with the source labelled | Pull with resolutions; on protected main a new head resets approval |
| Duplicate URN or ambiguous triple in main | `ambiguous_identity`; skipped | Dedup script, then the issue auto-clears |
| Over budget | 100%: throttled (60 s flush) and compaction prioritised. 120%: paused_budget, Kafka holds the data, admins notified via the outbox relay | Admin raises the budget or lowers retention; auto-resume below 90% |
| Compaction crashes mid-run | Txn A is atomic; 410s are already correct; B is idempotent and resumes from its cursor | Automatic. A root mismatch aborts, pages, and the job is not retried. |
| Compaction races a pinner | gvcompact exclusive/shared: either the pinner registers first (seq protected) or it gets 410 | None |
| Compaction during a lifecycle job | Graph skipped | Next night |
| Mapping bug writes bad values | — | Pause (M), fix, approve (P), replay from T (the higher epoch wins ties). Or revert specific in-window commits with target=draft plus a PR (or bypass). Compacted commits cannot be reverted. Identity-changing fixes leave orphans, reported by the dry run. |
| Purge of a graph with sources | Quiesce cancels ingest jobs; rows deleted; revisions kept; router ignores the source | None |

---

## Rollout & migration of existing data

### Sequencing (contract §17)

1. **Prerequisite: ACCESS R0.** Permission seed, `_SEED_LEAVES` (permission_service.py:430-433, today `{manage, read}` only), forced claims refresh. Required before INGEST S2 activation (X-20).
2. **INGEST S0, with CONVERSION L2.**
   - `system_ontology.json` CONTAINS widening.
   - Plan 0.4: lock timeouts, `LockBusy`, retry on every main writer.
   - Plan 1.3: `_window_overlaps` with the service split, and `_compute_merge_bounded(extra_changed)`.
   - Plan 1.6: `read_route`, projector throughput, nudge coalescing.
   - Plan 1.7: `actor_kind` usage and `change_reason`.
   - Exit: existing suites green; the D2 streaming tests and the EXPLAIN tests on `ix_commits_actor` green.
3. **INGEST S1.**
   - Migrations 2, 8, 10 become active in code.
   - `_commit_values` extraction, `apply_source_delta`, `identity.py`, `source_policy`, keyed lists.
   - `sync_ingest` moves onto the shadow.
   - The falkordb_snapshot binding and shadow seeding (with CONVERSION drift_sync).
   - The lifecycle hook.
   - Exercised only through InMemoryFeed and drift_sync.
   - Exit: fence, coexistence, quarantine, scope, identity and lifecycle-composition suites green.
4. **INGEST S2.**
   - ingest-worker (router, applier, jobs), decoders, admin API, metrics, deploy, aiokafka.
   - Activation is refused unless CONVERSION live plus an owned key (enforced by the API).
   - Exit: chaos oracle and offset audit clean on Redpanda.
   - The UI (S3) ships with S2.
5. ACCESS R2 shadow / R3 enforce; CONVERSION L4 adoption.
6. **INGEST S4 compaction.**
   1. `GRAPHVER_COMPACTION_MODE=report` writes `planned` rows only.
   2. Verify on a staging restore of a production snapshot.
   3. Full backup.
   4. Enforce with N=30 d.
   5. Lower to 14 d after 7 clean nights (0 root mismatches, 0 unexpected 410s).
7. ACCESS R4 protection, ingest graphs first.
8. Go-live gate.

**Chain linearity.** Contract §17 deploys migrations "1-5 and 9" at R0 and "2, 8, 10" at S1, but the chain is linear: 8 must run before 9. INGEST therefore assumes that all of migrations 1-11 are applied in order at the R0 deploy (they are additive), and that S1 is when INGEST code starts using 2, 8 and 10. See Open questions.

### Existing data
- **`actor_kind` backfill** (migration 2): genesis, import and sync become `system`; others stay at the default `human`.
- **`storage_bytes_est`.** A one-off batched estimation job per graph (`pg_column_size` over versions plus Merkle rows), run as `system:storage_guard`. For converted graphs, CONVERSION `finalize_pg` sets it, and T1 sets `storage_budget_bytes = max(default, 2 × preflight.pgBytes)` (X-11).
- **Existing graphs have no shadow.** The first-contact rule and claim-on-first-contact make that safe.
- **Graphs synced via `/sync`.** An implicit snapshot row is created on the next sync. Its shadow is seeded from the latest import/sync version rows per entity (approximate, documented).
- **Bindings** seed from the converge-verified baseline (Concepts §12).
- **Self-approved sources** on graphs later protected keep running, with a countersign badge (X-25).

### Enabling streams
1. Create `graphver.changes` and its ACLs.
2. Deploy with `ingestApplyEnabled` off.
3. Per source: wizard → dry run → approve (P, four-eyes on protected graphs) → activate (paused) → resume → watch for 24 h.
4. Ramp: 1 pilot graph, then 10, then all; at most 20 new sources per day.
5. Pilot entry: `ambiguous_identity` ≤ 0.1% in the dry run, and `sourcePathsOverwrittenHumanAuthored = 0` unless signed off.

### Rollback
- **Global:** `ingestApplyEnabled=false` (Kafka holds data for 7 d). **Per source:** pause.
- **Code rollback** is safe because the schema is additive.
- **Compaction** cannot be undone; mitigated by report mode, staging verification and a backup.

### Docs
- New `docs/versioning/12-streaming-ingestion.md` (including the full proofs) (compaction included).
- Updates to `03` §3.13, `docs/RBAC.md` and `10-authoritative-sources`.
- Runbooks: pause/resume, breaker, redrive, replay, retention gap, topic cut-over, budget, root mismatch, lifecycle-held rejects.

### Capacity (validated at S5)
- **Events:** 4.8M/day (56/s average, 2,000/s burst), about 60 assertions per event, about 40k distinct entity assertions/s at burst after a 10 s fold.
- **Commits:** at most 20/s fleet-wide.
- **Retained growth:** 0.4-2.3 GB/day after compaction.
- **Shadow:** about 40 GB, counted against budgets.
- **Kafka:** about 150 GB broker disk.
- **Connections:** 40-160 ingest PG connections via PgBouncer in transaction mode.
- **Pods:** applier 4-16 × 2 vCPU (KEDA); router 2-4.
- **Gate:** if retained growth exceeds 2.2 GB/day, raise the flush window to 30 s, then tighten the field policy, then lower N, then raise the budget.

---

## Tests & pass criteria

**Unit**
- **`backend/tests/ingest/test_openlineage_golden.py`.** Fixtures: START, RUNNING, COMPLETE, FAIL, ABORT, Job and Dataset events, DROP/RENAME, nested schema, column lineage, symlinks, parent run, ownership, unknown facets, a 1 MB schema.
  - Pass: byte-identical output across runs; `dataJob CONSUMES dataset`; `dataFlow CONTAINS dataJob`; hint strength; volatile fields only in `run_state`; 0 ontology violations against the widened `system_ontology.json`.
- **`test_decoder_conformance.py`** (all four decoders). 10k Hypothesis examples each with 0 exceptions; schema-valid output; `validate_options` problems under strict rules, including `ontology_containment_missing`.
- **`test_envelope_compat.py`.** v ≤ N accepted; unknown additive fields ignored; v > N gives reject `unsupported_envelope_version`.
- **`test_source_policy.py`, `test_merge_keyed_list.py`.** Guardrail precedence at runtime and at save (422). Keyed-list merge cases. The `merge.py` self-test passes.
- **`test_lww_crdt.py`** (Hypothesis, 5k examples). With R=0, permutations and duplicates give an identical shadow and main. With R>0, divergence happens only in the documented window.
- **`test_partition_tracker.py`, `test_batching.py`, `test_classify.py`, `test_bisect.py`.**
  - The low watermark never passes an unprocessed offset.
  - Flush triggers fire.
  - `GraphNotWritable` with `cutover_settling` retries; other reasons hold.
  - One poison envelope out of 512 is found in 9 or fewer applies.
- **`test_service_signatures`.** `apply_source_delta` and every ingest service entry point have a required keyword-only `principal`.
- **`test_access_matrix` (CSV fixture).** Every INGEST_* action and `STORAGE_EDIT` × {R, M, P, A} × {protected, unprotected} matches contract §2. INGEST actions never enter shadow mode.
- **`accessCopy` completeness (vitest).** Every ingest code in contract §6 has copy.

**Integration (GRAPHVER_E2E, real PG)**
- **`test_ingest_fence.py`.**
  - Offsets 100-200, then redeliver 100-150: no commit, L=200, fenced +51.
  - Crafted router duplicates are dropped.
  - A no-net-change batch advances offsets with no commit.
  - Replay, redrive and snapshot deliveries bypass the fence without lowering L.
  - Pass: the audit invariant holds exactly.
- **`test_ingest_coexistence.py`.** The prior suite: first contact, shared conflict and auto-clear, `overridden` receipt, `delete_modify`, placement hint, claim-on-first-contact. Pass: exact main values, issues and shadow rows.
- **`test_ingest_scopes_breaker.py`.** Complete-scope retraction; an older scope is skipped; column drop cascades. Breaker: 600 of 1,000 gives `blocked`, nothing applied, envelopes held; confirm applies exactly those.
- **`test_ingest_quarantine.py`.** 498 of 500 commit, 2 `invalid` issues; bisection; `DanglingReference` gives 422 and is classified permanent.
- **`test_ingest_identity_concurrency.py`.**
  - A converted graph with imported `a|CONSUMES|b`: an OpenLineage assertion updates it, with 0 new edge heads (X-09).
  - Two parallel heads give `ambiguous_identity`.
  - Concurrent first creates give 1 head.
  - Pass: no duplicate live URN or triple.
- **`test_ingest_lifecycle_composition.py`** (X-08).
  - Freeze pauses active, throttled and blocked sources (`lifecycle:frozen`, revision by `system:lifecycle`); in-flight envelopes are held; unfreeze resumes and redrives held rejects to 0 open.
  - `cutover_settling` retries without rejects.
  - Detach retires.
  - Resume on a frozen graph gives 409 `graph_not_writable`.
  - Activation on `live_legacy` gives 409 `projection_not_adopted`.
  - Purge leaves 0 ingest rows.
  - Policy approval with in-flight envelopes: held as `policy_changed`, redrive re-decodes; 0 lost.
- **`test_ingest_snapshot_binding.py`** (X-07).
  - Activation seeds the shadow from import rows.
  - A node deleted in the source after cutover is retracted on the next drift_sync.
  - A human-edited entity yields `delete_modify`.
  - `autoApply=false` writes only issues.
  - Release retires the binding.
  - Commits are kind `ingest` with actor `svc:ingest:<sid>`.
- **`test_sync_on_shadow.py`** (X-21, AUTOVSHUMAN-01). Three identical syncs leave curation intact; a user-created node survives; commits are kind `sync`, actor `system:sync`, with `requested_by` set; on a protected graph without bypass, 409 `review_required`.
- **`test_publish_gate_streaming.py`** (D2). The prior cases (auto-rebase, a different field lands, same field gives `merge_conflict` with `sourceName`, human overlap gives `people`, structural gives `structure`, `always` keeps today's behaviour). Livelock test: an ingest every 200 ms for 60 s against 20 publishers; 100% succeed within 3 attempts, p95 under 2 s.
- **`test_ingest_protected_main.py`** (X-05, X-25).
  - Source commits land without a PR, with `source_ref.policy_version` and `approved_by`.
  - Self-approval on a protected graph gives 403 `self_approval_forbidden`.
  - Guardrail claim gives 422.
  - Take source → main: R/M gets 403, P succeeds (commit kind `edit`, actor_kind `human`, `issue:<iid>`).
  - Value → main on a protected graph gives 409 `review_required{canStageToDraft}`; with a bypass it succeeds and writes access_events `bypassed`.
  - Target=draft as a non-member gives 404.
  - Enabling `require_review` lists self-approved sources.
- **`test_ingest_gate_order.py`** (X-27). Crafted multi-violation requests return the first failing code per contract §7, e.g. resume on a frozen graph by an M-only user gives `graph_not_writable`; apply on a blocked source with stale offsets gives HOLD before the fence.
- **`test_ingest_d1_platform_keys.py`** (+FalkorDB).
  - The original key is byte-identical after 1,000 ingest commits (counts plus property checksum).
  - The projector refuses non-owned keys (watermark unchanged).
- **`test_hardened_writers_vs_ingest.py`.** sync, bulk, revert and restore race the ingest loop, 50 iterations each: 0 IntegrityError, 0 HTTP 500, only success or retryable 409/503.
- **`test_ingest_jobs_idempotency.py`** (X-16). Three sequential replays of one source all succeed; a concurrent second gives 409 `replay_in_progress`; dry-run keys roll by hour.
- **`test_compaction.py`.**
  - All protected seqs, *including `cutover_seq`*, survive.
  - 200 random kept seqs: `_heads_as_of`, `_values_at`, `root_at` and `merkle_root` are identical.
  - Draft reads and diffs between kept seqs are identical.
  - Inside a range: 410 on diff, state-at, restore, restore-preview, revert, export and trace.
  - Crash after txn A, then resume, converges.
  - A concurrent restore either succeeds or gets 410.
  - A graph with a pending lifecycle job is skipped.
  - A `sync` or `import` commit is never removed.
  - Report mode deletes 0 rows.
  - At least 60% of rows removed on the synthetic corpus.
- **`test_storage_guard.py`.** warn, critical (throttled), over (paused_budget), recovery below 90%. Revisions plus outbox relay rows. `storage_guard` is the only writer of `storage_state`.
- **`test_purge_ingest.py`** (X-14). After purge, 0 rows for :g in every graphver table except `access_events`, `lifecycle_events`, `ingest_source_revisions` and the purge job row.
- **`test_migrations_lifecycle_v2`.** After upgrade head on an empty DB, `ck_jobs_type` and `ck_commits_kind` live domains equal the ORM; one JobORM row of every type inserts; `uq_commits_idem` exists on every partition.

**Kafka / chaos / load**
- **`test_ingest_kafka_e2e.py`** (Redpanda). Pause, produce, resume: nothing missing. Rewind with the epoch tie-break; held redrive; retention gap refusal. Pass: main equals the fixture and the audit balances.
- **`backend/tests/chaos/test_ingest_oracle_replay.py`** (nightly). 1M events plus 50 human editors, plus a freeze/unfreeze cycle and one policy approval mid-run. Faults: SIGKILL, scaling 1→4→1, PG failover, `pg_terminate_backend`, a FalkorDB pause, a 90 s zombie partition.
  - Pass: main equals the single-threaded oracle; audit residual 0; 0 duplicate URNs; PG and FalkorDB converge within 5 min; 0 lost human commits.
- **`loadtest/scenarios/versioning_collab_ingest.py`.** 500 graphs, 500 events/s sustained with 2,000/s bursts, 300 Locust users.
  - Pass: event→commit p95 < 30 s and p99 < 120 s; event→FalkorDB p95 < 90 s; publish p95 < 2 s and ≤ +20% vs baseline; ≥ 99% success; 0 5xx; PG CPU < 70%; human lock wait caused by ingest p99 < 1 s.
  - 72 h soak: flat RSS, lag and autovacuum backlog.

**Frontend**
- **`frontend/src/features/ingest/__tests__/*.test.tsx`** (vitest, RTL, axe).
  - Panel states, including lifecycle-paused and needs-countersign.
  - Buttons follow `access.can`.
  - The wizard is blocked on dry-run failure.
  - The inbox: a 409 conflict keeps picks; `review_required` offers stage-to-draft.
  - Chips; the People filter.
  - 0 axe violations.
- **Playwright (nightly):** connect a source; the entity appears on the canvas within 90 s.

---

## Findings resolved

**Ingest primitive (INGESTPRIM)**

| Finding | Resolution |
|---|---|
| INGESTPRIM-01, AUTOVSHUMAN-02 (livelock) | D2 `on_overlap` with the service-overlap bounded merge |
| INGESTPRIM-02 | Plan 1.6 as-of rewrite, plus 1 commit per flush per (graph, source), plus compaction |
| INGESTPRIM-03 | X-24 routing order; service-only lag tolerance |
| INGESTPRIM-04 | Scoped retractions over the shadow; delete governance |
| INGESTPRIM-05 | Fence (Lemmas 1-2), CRDT shadow (Lemma 3), `uq_commits_idem` |
| INGESTPRIM-06 | Identity under the lock, deterministic ids, list-valued resolvers, contract §13 |
| INGESTPRIM-07 | `DanglingReference`, quarantine, bisection, classification |
| INGESTPRIM-08 | lock_timeout, `LockBusy`→503, `_head_values`, shadow-hash cache |
| INGESTPRIM-09, AUTOVSHUMAN-07 | Lock plus retry on sync, bulk, revert and restore |
| INGESTPRIM-10 | Plan 1.6 dependency; adaptive flush |
| INGESTPRIM-11, STORE-7 | `run_state` split, compaction, budgets |
| INGESTPRIM-12 | Dedicated Kafka worker with low-watermark commits |

**Automated vs human (AUTOVSHUMAN)**

| Finding | Resolution |
|---|---|
| AUTOVSHUMAN-01 | Shadow merge base |
| AUTOVSHUMAN-03 | `source_policy`, keyed lists, guardrails |
| AUTOVSHUMAN-04 | Bounded merge |
| AUTOVSHUMAN-05 | `ingest_issues` and receipts |
| AUTOVSHUMAN-06 | Recovery path per X-12(f); 410 on compacted targets |
| AUTOVSHUMAN-08 | Placement strength and the structural probe |
| AUTOVSHUMAN-09 | Freshness split and adaptive polling |
| AUTOVSHUMAN-10 | `actor_kind`, `source_ref`, `change_reason`, history filters |
| AUTOVSHUMAN-11 | Debounced `after_projection` |

**Other findings**
- STORE-4: `purge` is in the union `ck_jobs_type`.
- APIOPS-4, TESTS-5 and TESTS-6: the ingest parts.
- HISTORY-7: partial.

**Judge defects and earlier new defects.** Judge defects 1-10 and new defects A-M are retained as in the prior draft. Defect C's fix is now extended: in-flight envelopes for non-applyable sources and stale policy versions are held, not dropped.

**Integration issues applied**

| Issue | Change in this spec |
|---|---|
| X-01, X-02 | Own migrations deleted; chain revisions referenced |
| X-03 | Error mapping |
| X-04 | Matrix and Action enum |
| X-05 | Issue resolve authorization |
| X-07 | Snapshot binding |
| X-08 | Lifecycle hook and applyability |
| X-09 | Triple-first identity |
| X-10 | Two-value domain |
| X-11 | Budget source of truth |
| X-12 | Compaction set, `cutover_seq`, job skips, 410 everywhere |
| X-13 | Single audit sink, no access_events from ingest |
| X-14 | Purge tables |
| X-16 | Job keys |
| X-17 | Capability envelope |
| X-18 | Hub layout and a single inbox |
| X-19 | Own drift and release rules dropped |
| X-20 | Non-legacy enforcement and the R0 prerequisite |
| X-21 | `sync` semantics and signature |
| X-24 | Read routing |
| X-25 | Four-eyes and countersign |
| X-26 | Actor strings and job principal snapshots |
| X-27 | Gate order tests |
| X-28 | Worker roles, claim map, kill switch, pause allowlist |
| X-29 | `policy_version` kept |
| X-30 | Ontology widening in S0 and `ontology_containment_missing` |

**Re-verified code claims during this pass:**
- `_heads_by_edge_triple` (service.py:5243) and `_heads_by_urn` (5224) collapse duplicates. This is why the `_all` variants are required.
- `change_reason=None` is at service.py:5720 and 5730.
- The dangle `ConcurrencyError` is at 5546.
- Gates are at 929 and 2118; the window union is at 4653.
- `_WRITE_ALLOWLIST_SUFFIXES` uses `endswith` (versioning_gate.py:33, 61).
- `_SEED_LEAVES` lacks publish (permission_service.py:430-433).
- `_BULK` and `_phase_meta` are as stated (purge_worker.py:65, 365).
- `ck_jobs_type` lacks `purge` (models.py:355).

---

## Open questions

1. **Contract additions needing sign-off.** These are not in contract §4/§6 verbatim:
   - `version_conflict.resource='ingest_issue'` (a stale issue, keyed on `oursHash`);
   - `source_state.detail` values (`nothing_pending`, `not_blocked`, `token_mismatch`, `name_exists` is folded into `invalid_source_config`);
   - `urn_strategy='identity'` for the snapshot decoder;
   - HOLD (not deny) for paused, paused_budget and `policy_changed`, which zero-loss requires;
   - extra `ingest_rejects.reason` and `ingest_source_revisions.action` values.
2. **Chain deploy timing.** Contract §17 places migration 9 at R0 and 8/10 at S1, which a linear chain cannot do. Proposal: apply all of 1-11 at R0 (all additive); S1 only starts using them.
3. **Kafka platform.** Cluster, SASL/TLS, ACLs, raw retention ≥ 7 d, schema registry. Also whether pinned aiokafka supports static membership; otherwise accept rebalances or switch to confluent-kafka.
4. **Defaults to confirm after S5.** N (14 d, rollout at 30 d), the 2 GiB default budget, how the 500 GB fleet is split, and R = 6 h vs exact LWW (R=0) for compliance graphs.
5. **Four-eyes everywhere?** Should four-eyes apply to every source approval, not only on protected graphs?
6. **Authoritative graphs.** Should `description` and `displayName` default to `source` on `graphs.kind='authoritative'`?
7. **Beyond v1.** An HTTP push endpoint; cross-data-source lineage (stub nodes vs fan-out); a TTL'd run history; an automated re-key job for identity-changing mapping fixes.

---

### Critical Files for Implementation
- /home/user/dataviz/backend/app/services/versioning/service.py
- /home/user/dataviz/backend/app/services/versioning/models.py
- /home/user/dataviz/backend/app/api/v1/endpoints/versioning.py
- /home/user/dataviz/backend/app/services/versioning/purge_worker.py
- /home/user/dataviz/backend/app/services/versioning/worker.py
