"""Async, resumable, integrity-validated "enable version control" bootstrap.

Turning on version control for a data source that already holds data means copying
its ENTIRE provider graph into the versioned store. The old path did that inline in
the HTTP request: it paged the whole graph into one Python list (OFFSET pagination),
then wrote it in ONE transaction. That is fine at 10k entities and fatal at 10M —
the request times out, the web tier's memory is O(graph), and the user gets a
spinner with no idea whether anything survived.

This module replaces it with a job:

  counting → nodes → edges → validate → heads → merkle → backfill → finalize → done

**Bounded memory.** The source is scanned in ID-RANGE windows (never OFFSET — deep
offsets re-scan and go quadratic) and written in per-window transactions, so peak
memory is O(window), not O(graph).

**Resumable.** Each window commits its rows, tallies, and its cursor in ONE
transaction, so a crash rewinds to the last committed window exactly. Version rows
carry DETERMINISTIC ids (hash of commit+entity) and insert ON CONFLICT DO NOTHING,
so replaying a window is a no-op. A `running` job whose heartbeat goes stale is
taken over by another worker.

**Invisible until proven.** The import commit is written at seq 2 while the graph's
head stays at genesis (seq 1). Every read path composes state bounded by
`main_head_commit_seq`, so a partial — or failed — ingest is invisible: the data
source simply reads as "not versioned yet". Validation therefore runs BEFORE
`entity_heads` is populated and long before the head flip: if it fails, there is
nothing to unwind and nothing to see.

**Proven, not assumed.** Validation compares the source's own counts (the same
helpers the projection reconciler uses) against what actually landed, per node label
and per edge type — that is the containment/lineage-preservation proof — asserts no
entity was dropped, and re-reads a random sample of entities from the SOURCE to
compare content hashes against the stored payloads. The full report is persisted on
the job and rendered in the UI.

**No reseed.** The versioned graph is pinned to the SOURCE FalkorDB graph the canvas
already reads, and validation has just proved the two agree — so finalize
fast-forwards the projection watermark instead of dropping and rewriting 10M
entities (which would also wipe the `:AGGREGATED` rollups and force an hours-long
re-aggregation). The one thing the projector needs that a raw source graph may lack
is the delete-anchoring keys (`n.entityId`, `r.id`); `backfill` adds them in place,
additively — and it runs BEFORE `finalize`, so the graph is never live without them.

`finalize` is therefore the only irreversible step, and it is last: until it runs the
data source is simply un-versioned, and abandoning the job leaves no trace.
"""
from __future__ import annotations

import asyncio
import inspect
import logging
import random
from hashlib import blake2b
from typing import Dict, List, Optional, Tuple

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from . import config, db
from .merkle import content_hash
from .merkle_store import MerkleStore
from .models import (
    BranchORM,
    CommitORM,
    EdgeVersionORM,
    GraphORM,
    JobORM,
    NodeVersionORM,
    ProjectionStateORM,
    _now,
)
from .projection import _q, _READ_TIMEOUT_MS, _WRITE_TIMEOUT_MS
from .service import (
    ConcurrencyError,
    GraphVersioningService,
    _chunks,
    _rows_per_insert,
    _sanitize_node_properties,
)

logger = logging.getLogger(__name__)

# The job's own type. NOT 'ingest' — that belongs to the FILE-import worker
# (``import_export/service.py``). A worker claims work by ``job_type``, so sharing one
# would have each worker pick up the other's jobs and run them through the wrong phase
# machine. Keeping the claim sets disjoint by construction is the whole point.
BOOTSTRAP_JOB_TYPE = "bootstrap"

# Phase order. `last_cursor` is prefixed with the phase it belongs to, so a resume
# re-enters exactly where it stopped.
#
# `finalize` is LAST for a reason: it is the single irreversible step (it flips the head,
# which makes the graph live and writable). Everything that the live graph depends on must
# already be true when it runs — including `backfill`, which stamps the projector's
# delete/update anchors (`n.entityId`, `r.id`) onto the source graph. Finalizing first and
# backfilling after would leave a window (and, if backfill then failed, a permanent state)
# where the graph is editable but the projector cannot anchor: an edit would MERGE a
# DUPLICATE node beside the original, and a delete would match nothing and silently leave
# the entity on the canvas.
PHASES = ("counting", "nodes", "edges", "validate", "heads", "merkle", "backfill", "finalize")

# Percent shown to the user. Scanning dominates the wall clock, so it owns the bulk
# of the bar; the tail phases are bounded work with honest, distinct labels.
_PHASE_FLOOR = {"counting": 0, "nodes": 2, "edges": 2, "validate": 72,
                "heads": 76, "merkle": 88, "backfill": 92, "finalize": 98}
_SCAN_SPAN = 70          # nodes+edges occupy 2%..72%


# --------------------------------------------------------------------------- #
# Source scan (FalkorDB)                                                       #
#                                                                              #
# WHAT COUNTS AS "THE GRAPH": exactly what the application itself can see.     #
# The reader (`falkordb_provider._node_from_props` / `_edge_from_row`) drops a #
# node with no `urn` and any edge whose endpoints have none — such entities do #
# not render, search, or trace: they are not part of the user's graph. Copying #
# is scoped the same way, so "we copied everything" means the same thing to the#
# job as it does to the canvas. They are still COUNTED and surfaced in the      #
# report (never silently ignored).                                             #
#                                                                              #
# Derived/system artifacts are excluded outright: the `:AGGREGATED` rollup      #
# layer and its bookkeeping markers are the projector's and the aggregation     #
# worker's own output, not source data — importing them would make the graph    #
# own its own cache.                                                            #
# --------------------------------------------------------------------------- #
_DERIVED_LABELS = ("_GVRollupMeta", "_AggMeta", "_Projection")


def _not_derived(var: str) -> str:
    return " AND ".join(f"NOT '{lab}' IN labels({var})" for lab in _DERIVED_LABELS)


# EVERYTHING is anchored on a NODE id range — including the edges.
#
# The obvious way to window edges is `WHERE ID(r) >= $lo AND ID(r) < $hi`, and it is a
# trap: FalkorDB cannot seek an edge-id range, so every window re-scans the entire edge
# set and the phase goes quadratic. (Measured on a 6.2M-edge graph: ~230 edges/sec and
# falling, then a scan timeout.) Anchoring on the SOURCE NODE instead walks each node's
# adjacency list — what a graph database is actually for — and every edge is still
# emitted exactly once, by its source. It also means both phases share one cursor space,
# so `edges:<lo>` and `nodes:<lo>` mean the same thing.
_MAX_NODE_ID = "MATCH (n) RETURN max(ID(n))"
_COUNT_NODES = f"MATCH (n) WHERE n.urn IS NOT NULL AND {_not_derived('n')} RETURN count(n)"
_COUNT_EDGES = ("MATCH (a)-[r]->(b) WHERE type(r) <> 'AGGREGATED' "
                "AND a.urn IS NOT NULL AND b.urn IS NOT NULL RETURN count(r)")
# Entities the app can't see (no identifier) — reported, never copied, never fatal.
_COUNT_INVISIBLE_NODES = f"MATCH (n) WHERE n.urn IS NULL AND {_not_derived('n')} RETURN count(n)"
_COUNT_INVISIBLE_EDGES = ("MATCH (a)-[r]->(b) WHERE type(r) <> 'AGGREGATED' "
                          "AND (a.urn IS NULL OR b.urn IS NULL) RETURN count(r)")

_SCAN_NODES = (
    f"MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi AND n.urn IS NOT NULL AND {_not_derived('n')} "
    "RETURN labels(n), properties(n)"
)
_SCAN_EDGES = (
    f"MATCH (a) WHERE ID(a) >= $lo AND ID(a) < $hi AND a.urn IS NOT NULL AND {_not_derived('a')} "
    "MATCH (a)-[r]->(b) WHERE type(r) <> 'AGGREGATED' AND b.urn IS NOT NULL "
    "RETURN a.urn, b.urn, type(r), properties(r)"
)
_SAMPLE_NODES = "UNWIND $urns AS u MATCH (n {urn: u}) RETURN labels(n), properties(n)"
# Backfill: additive, idempotent, and scoped to the same entities we copied.
_BACKFILL_NODES = (
    f"MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi AND {_not_derived('n')} "
    "AND n.entityId IS NULL AND n.urn IS NOT NULL "
    "SET n.entityId = n.urn"
)
_BACKFILL_EDGES = (
    f"MATCH (a) WHERE ID(a) >= $lo AND ID(a) < $hi AND a.urn IS NOT NULL AND {_not_derived('a')} "
    "MATCH (a)-[r]->(b) WHERE type(r) <> 'AGGREGATED' AND r.id IS NULL AND b.urn IS NOT NULL "
    "SET r.id = a.urn + '|' + type(r) + '|' + b.urn"
)


def _vid(prefix: str, commit_id: str, entity_id: str) -> str:
    """Deterministic version-row id, so replaying a window after a crash collides
    with the row it already wrote (ON CONFLICT DO NOTHING) instead of duplicating it."""
    return prefix + blake2b(f"{commit_id}:{entity_id}".encode(), digest_size=12).hexdigest()


def _label_of(labels) -> Optional[str]:
    for lab in labels or []:
        if lab != "_GVRollupMeta":
            return lab
    return None


class _Reservoir:
    """Uniform sample of K items over a stream of unknown length, checkpointed with
    the job (so a resume keeps sampling correctly across the whole scan)."""

    def __init__(self, k: int, items: Optional[List[str]] = None, seen: int = 0):
        self.k, self.items, self.seen = k, list(items or []), int(seen)

    def offer(self, item: str) -> None:
        self.seen += 1
        if len(self.items) < self.k:
            self.items.append(item)
            return
        j = random.randint(1, self.seen)
        if j <= self.k:
            self.items[j - 1] = item


class BootstrapRunner:
    """Executes bootstrap (`job_type='bootstrap'`) jobs. Hosted by the versioning worker."""

    def __init__(self, graph_factory, *, session_factory=None, consumer: str = "boot-1"):
        self._factory = graph_factory
        self._session = session_factory or db.graphver_session
        self._consumer = consumer
        self._svc = GraphVersioningService()
        self._merkle = MerkleStore()
        self._epoch: Dict[str, int] = {}     # job_id → the claim we hold (see _own)

    # ---------------------------------------------------------------- infra --
    async def _client(self, ps: ProjectionStateORM):
        c = self._factory(ps.falkor_graph_name, ps.falkor_provider)
        if inspect.isawaitable(c):
            c = await c
        return c

    async def claim_one(self) -> Optional[str]:
        """Claim a pending job, or take over one whose worker looks dead (stale heartbeat).

        `JobORM` IS the durable queue — no second Redis stream to keep alive. The heartbeat
        is `updated_at`, refreshed on every window commit. `retry_count` doubles as the
        CLAIM EPOCH: a takeover bumps it, so the previous owner — which may be slow rather
        than dead, e.g. stuck in a long scan retry — discovers on its next commit that it no
        longer holds the job and stops instead of double-writing (see :meth:`_own`).
        """
        stale_before = _now_minus(config.INGEST_STALE_SECS)
        async with self._session() as s:
            row = (await s.execute(
                select(JobORM).where(
                    JobORM.job_type == BOOTSTRAP_JOB_TYPE,
                    text("(status = 'pending' OR (status = 'running' AND updated_at < :stale))")
                    .bindparams(stale=stale_before),
                ).order_by(JobORM.created_at).limit(1).with_for_update(skip_locked=True)
            )).scalars().first()
            if row is None:
                return None
            if row.status == "running":
                row.retry_count += 1                    # fence out the previous owner
                logger.warning("taking over stale bootstrap job %s (phase=%s cursor=%s)",
                               row.id, row.current_phase, row.last_cursor)
            row.status = "running"
            row.started_at = row.started_at or _now()
            row.updated_at = _now()
            row.error_message = None
            self._epoch[row.id] = row.retry_count
            return row.id

    def _own(self, job: JobORM) -> JobORM:
        """Assert we still hold this job, INSIDE the transaction that is about to write.

        Two things can pull the job out from under a running worker: another worker taking
        it over (stale heartbeat), and the user abandoning it (which deletes the graph).
        Checking here means the losing worker's write transaction aborts and rolls back
        rather than committing rows into a job — or a graph — that is no longer its own.
        """
        if job.status == "cancelled":
            raise BootstrapSuperseded("the job was cancelled")
        if self._epoch.get(job.id) is not None and job.retry_count != self._epoch[job.id]:
            raise BootstrapSuperseded("another worker took over this job")
        return job

    # ---------------------------------------------------------------- driver --
    async def run_job(self, job_id: str) -> Dict[str, object]:
        """Drive a claimed job to a terminal state. Each phase is individually
        resumable; a raised error marks the job failed with a plain-language reason
        and leaves everything it wrote intact (a retry resumes from the cursor)."""
        try:
            while True:
                async with self._session() as s:
                    job = await s.get(JobORM, job_id)
                    if job is None or job.status in ("completed", "cancelled"):
                        return {"job_id": job_id, "status": job.status if job else "missing"}
                    self._own(job)
                    phase = job.current_phase or "counting"
                    graph_id = job.graph_id
                runner = getattr(self, f"_phase_{phase}")
                done = await runner(job_id, graph_id)
                if done:
                    nxt = _next_phase(phase)
                    async with self._session() as s:
                        job = self._own(await s.get(JobORM, job_id))
                        if nxt is None:
                            job.status = "completed"
                            job.current_phase = None
                            job.progress = 100
                            job.completed_at = _now()
                            job.updated_at = _now()
                            logger.info("bootstrap %s completed (graph=%s)", job_id, graph_id)
                            return {"job_id": job_id, "status": "completed"}
                        job.current_phase = nxt
                        job.last_cursor = None
                        # Each phase re-learns its own window size (edge payloads are a
                        # different weight from node payloads).
                        job.batch_size = config.BOOTSTRAP_SCAN_WIDTH
                        job.updated_at = _now()
        except BootstrapSuperseded as exc:
            # Not an error: someone else owns this job now (a takeover, or the user
            # abandoned it). Our last write rolled back; stop quietly.
            logger.info("bootstrap %s handed off: %s", job_id, exc)
            self._epoch.pop(job_id, None)
            return {"job_id": job_id, "status": "superseded"}
        except BootstrapFailure as exc:
            await self._fail(job_id, exc.reason, exc.code)
            return {"job_id": job_id, "status": "failed", "error": exc.reason}
        except Exception as exc:                                   # pragma: no cover - infra
            logger.exception("bootstrap %s crashed", job_id)
            await self._fail(job_id, _friendly_infra_error(exc), "infrastructure")
            return {"job_id": job_id, "status": "failed"}

    async def _fail(self, job_id: str, reason: str, code: str) -> None:
        async with self._session() as s:
            job = self._own(await s.get(JobORM, job_id))
            if job is None:
                return
            job.status = "failed"
            job.error_message = reason
            job.updated_at = _now()
            summary = dict(job.summary or {})
            summary["failure"] = {"code": code, "reason": reason, "phase": job.current_phase}
            job.summary = summary

    # ---------------------------------------------------------------- phases --
    async def _phase_counting(self, job_id: str, graph_id: str) -> bool:
        """Read the source's own totals — the denominator every later check compares
        against (and the progress bar's total). Counted with the SAME predicates the
        scan uses, so "scanned == source" is a meaningful statement."""
        async with self._session() as s:
            ps = await s.get(ProjectionStateORM, graph_id)
        client = await self._client(ps)
        nodes = await self._count(client, _COUNT_NODES)
        edges = await self._count(client, _COUNT_EDGES)
        inv_nodes = await self._count(client, _COUNT_INVISIBLE_NODES)
        inv_edges = await self._count(client, _COUNT_INVISIBLE_EDGES)
        async with self._session() as s:
            job = await s.get(JobORM, job_id)
            summary = dict(job.summary or {})
            summary["source"] = {
                "nodes": nodes, "edges": edges,
                # Entities with no identifier: invisible to the reader (they never render,
                # search, or trace), so they are not copied — but the user is TOLD.
                "invisibleNodes": inv_nodes, "invisibleEdges": inv_edges,
            }
            summary.setdefault("scanned", {"nodes": 0, "edges": 0, "byLabel": {}, "byType": {}})
            summary.setdefault("written", {"nodes": 0, "edges": 0})
            summary.setdefault("rejected", {"duplicateUrns": 0, "danglingEdges": 0, "samples": []})
            summary.setdefault("collapsedParallelEdges", 0)
            summary.setdefault("sample", {"nodes": [], "nodesSeen": 0})
            job.summary = summary
            job.total = nodes + edges
            job.processed = 0
            job.updated_at = _now()
        logger.info("bootstrap %s: source has %d nodes / %d edges (%d/%d without an identifier)",
                    job_id, nodes, edges, inv_nodes, inv_edges)
        return True

    async def _count(self, client, cypher: str) -> int:
        res = await _q(client, cypher, timeout_ms=_WRITE_TIMEOUT_MS)
        rs = getattr(res, "result_set", None) or []
        return int(rs[0][0]) if rs and rs[0] and rs[0][0] is not None else 0

    async def _phase_nodes(self, job_id: str, graph_id: str) -> bool:
        return await self._scan_phase(job_id, graph_id, kind="nodes")

    async def _phase_edges(self, job_id: str, graph_id: str) -> bool:
        return await self._scan_phase(job_id, graph_id, kind="edges")

    async def _scan_phase(self, job_id: str, graph_id: str, *, kind: str) -> bool:
        """One ID-range window: scan the source, convert, write version rows, and
        checkpoint tallies + cursor — all in ONE transaction, so the counters can
        never drift from the rows (and a crash rewinds both together)."""
        async with self._session() as s:
            # Own it before touching anything: if the job was abandoned, the graph and its
            # import commit are already gone, and the honest answer is "not mine any more"
            # — not "the import commit is missing".
            job = self._own(await s.get(JobORM, job_id))
            ps = await s.get(ProjectionStateORM, graph_id)
            commit = await self._import_commit(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            cursor, summary = job.last_cursor, dict(job.summary or {})
            actor = str(summary.get("actor") or "system")
            width = job.batch_size or config.BOOTSTRAP_SCAN_WIDTH
        client = await self._client(ps)

        lo = int(cursor.split(":")[-1]) if cursor else 0
        max_id = await self._max_id(client, kind)
        if max_id is None or lo > max_id:
            return True                                        # nothing (left) to scan

        rules = await _ontology_rules(job_id)
        rows, width = await self._scan(client, kind, lo, width)
        hi = lo + width

        # Convert → validate → rows. Rejections are counted, never silent.
        if kind == "nodes":
            dicts, tallies, rejects, sample, dupes = self._nodes_to_rows(
                rows, commit, main_id, graph_id, actor, rules, summary)
        else:
            endpoint_urns = {u for r in rows for u in (r[0], r[1]) if u}
            live = await self._known_nodes(graph_id, commit.id, endpoint_urns)
            dicts, tallies, rejects, sample, dupes = self._edges_to_rows(
                rows, commit, main_id, graph_id, actor, rules, live)

        model = NodeVersionORM if kind == "nodes" else EdgeVersionORM
        async with self._session() as s:
            job = self._own(await s.get(JobORM, job_id))    # abort before writing if fenced
            # ON CONFLICT DO NOTHING is what makes a replayed window a no-op — but it also
            # silently swallows a genuine duplicate identifier that first appeared in an
            # EARLIER window (the in-window `seen` set can't see across windows). So trust
            # the rowcount, not the batch size: whatever didn't insert is a duplicate, and
            # duplicates fail the job. (Rows and cursor commit together, so a resume never
            # re-scans a window that landed — a conflict here really is a duplicate.)
            inserted = 0
            for batch in _chunks(dicts, _rows_per_insert(dicts)):
                res = await s.execute(
                    pg_insert(model).values(batch).on_conflict_do_nothing(
                        index_elements=["graph_id", "id"]))
                inserted += res.rowcount if res.rowcount is not None and res.rowcount >= 0 else len(batch)
            cross_window_dupes = max(0, len(dicts) - inserted)
            if kind == "nodes":
                rejects["duplicateUrns"] = int(rejects.get("duplicateUrns", 0)) + cross_window_dupes
            else:
                dupes += cross_window_dupes
            summary = _merge_scan_summary(
                dict(job.summary or {}), kind, scanned=len(rows), written=inserted,
                tallies=tallies, rejects=rejects, sample=sample, dupes=dupes)
            job.summary = summary
            job.processed = int(summary["written"]["nodes"]) + int(summary["written"]["edges"])
            job.progress = _percent(kind, job.processed, job.total)
            job.last_cursor = f"{kind}:{hi}"
            # Remember the width that fit: without this the next window starts at the
            # configured size again and re-pays a failed query to rediscover the same answer.
            job.batch_size = width
            job.updated_at = _now()
            job.last_sequence = job.last_sequence + 1
        return False                                           # more windows may remain

    async def _phase_validate(self, job_id: str, graph_id: str) -> bool:
        """Prove the copy before ANY of it becomes visible.

        Runs before `entity_heads` exists and long before the head flip, so a failure
        leaves a graph that is still, in every sense, un-versioned."""
        async with self._session() as s:
            job = await s.get(JobORM, job_id)
            ps = await s.get(ProjectionStateORM, graph_id)
            commit = await self._import_commit(s, graph_id)
            summary = dict(job.summary or {})
            # What actually landed, per label / per edge type — the containment &
            # lineage preservation proof (every declared relationship type survives).
            pg_labels = dict((await s.execute(text(
                f'SELECT entity_type, count(*) FROM {_t("node_versions")} '
                "WHERE graph_id = :g AND commit_id = :c GROUP BY 1"
            ).bindparams(g=graph_id, c=commit.id))).all())
            pg_types = dict((await s.execute(text(
                f'SELECT edge_type, count(*) FROM {_t("edge_versions")} '
                "WHERE graph_id = :g AND commit_id = :c GROUP BY 1"
            ).bindparams(g=graph_id, c=commit.id))).all())
            dangling = (await s.execute(text(
                f'SELECT count(*) FROM {_t("edge_versions")} e '
                f'WHERE e.graph_id = :g AND e.commit_id = :c AND ('
                f'  NOT EXISTS (SELECT 1 FROM {_t("node_versions")} n '
                "             WHERE n.graph_id = :g AND n.commit_id = :c "
                "               AND n.entity_id = e.source_entity_id) OR "
                f'  NOT EXISTS (SELECT 1 FROM {_t("node_versions")} n '
                "             WHERE n.graph_id = :g AND n.commit_id = :c "
                "               AND n.entity_id = e.target_entity_id))"
            ).bindparams(g=graph_id, c=commit.id))).scalar_one()

        src = summary.get("source") or {}
        scanned = summary.get("scanned") or {}
        written = summary.get("written") or {}
        rejected = summary.get("rejected") or {}

        checks: List[dict] = []

        def check(key: str, ok: bool, detail: str, blocking: bool = True) -> None:
            checks.append({"key": key, "ok": bool(ok), "detail": detail, "blocking": blocking})

        # 1. Everything in the source was seen.
        check("nodes_seen", scanned.get("nodes") == src.get("nodes"),
              f"scanned {scanned.get('nodes'):,} of {src.get('nodes'):,} items")
        check("edges_seen", scanned.get("edges") == src.get("edges"),
              f"scanned {scanned.get('edges'):,} of {src.get('edges'):,} connections")
        # 2. Nothing was silently dropped on the way in.
        check("no_duplicate_items", int(rejected.get("duplicateUrns", 0)) == 0,
              f"{rejected.get('duplicateUrns', 0)} item(s) sharing an identifier")
        check("no_dropped_connections", int(rejected.get("danglingEdges", 0)) == 0,
              f"{rejected.get('danglingEdges', 0)} connection(s) with a missing endpoint")
        # 3. What we wrote reconciles exactly with what we saw.
        exp_nodes = scanned.get("nodes", 0) - int(rejected.get("duplicateUrns", 0))
        exp_edges = (scanned.get("edges", 0) - int(rejected.get("danglingEdges", 0))
                     - int(summary.get("collapsedParallelEdges", 0)))
        check("nodes_written", written.get("nodes") == exp_nodes,
              f"{written.get('nodes'):,} items stored")
        check("edges_written", written.get("edges") == exp_edges,
              f"{written.get('edges'):,} connections stored")
        # 4. Types survived — per label and per relationship type.
        src_labels = {k: v for k, v in (scanned.get("byLabel") or {}).items()}
        src_types = {k: v for k, v in (scanned.get("byType") or {}).items()}
        check("labels_preserved", _tally_matches(pg_labels, src_labels),
              f"{len(src_labels)} item type(s) preserved")
        check("types_preserved", _tally_matches(pg_types, src_types, allow_lower=True),
              f"{len(src_types)} relationship type(s) preserved")
        # 5. No edge points at an item that isn't there.
        check("referentially_whole", int(dangling) == 0,
              f"{dangling} connection(s) referencing a missing item")

        # 6. Re-read a random sample from the SOURCE and compare content hashes —
        #    counts alone can't catch a mangled payload.
        sample_urns = list((summary.get("sample") or {}).get("nodes") or [])
        matched, mismatched = await self._verify_sample(
            graph_id, commit.id, ps, sample_urns, await _ontology_rules(job_id))
        check("sample_matches", not mismatched,
              f"{matched} of {len(sample_urns)} re-checked items match exactly")

        blocking = [c for c in checks if c["blocking"] and not c["ok"]]
        report = {
            "checks": checks,
            "source": src,
            "stored": {"nodes": written.get("nodes", 0), "edges": written.get("edges", 0)},
            "labels": src_labels,
            "edgeTypes": src_types,
            "sampleChecked": len(sample_urns),
            "sampleMismatched": mismatched[:10],
            "mergedDuplicateConnections": int(summary.get("collapsedParallelEdges", 0)),
            # Not copied because the app can't see them either (no identifier) — stated
            # plainly rather than hidden, so "everything was copied" stays true.
            "skippedWithoutIdentifier": {
                "nodes": int(src.get("invisibleNodes", 0)),
                "edges": int(src.get("invisibleEdges", 0)),
            },
            "merkle": "pending",
        }
        async with self._session() as s:
            job = self._own(await s.get(JobORM, job_id))
            summary = dict(job.summary or {})
            summary["report"] = report
            job.summary = summary
            job.progress = _PHASE_FLOOR["validate"]
            job.updated_at = _now()

        if blocking:
            raise BootstrapFailure(_explain_failed_checks(blocking), "integrity")
        logger.info("bootstrap %s: integrity checks passed (%d checks)", job_id, len(checks))
        return True

    async def _phase_heads(self, job_id: str, graph_id: str) -> bool:
        """Publish the entity head pointers (keyset-windowed, server-side INSERT…SELECT
        so no rows travel through Python). Only reached once validation has passed."""
        async with self._session() as s:
            job = await s.get(JobORM, job_id)
            commit = await self._import_commit(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            cursor = job.last_cursor or "heads:nodes:"
            kind = "edges" if cursor.startswith("heads:edges") else "nodes"
            after = cursor.split(":", 2)[2] if cursor.count(":") >= 2 else ""
            table = "node_versions" if kind == "nodes" else "edge_versions"
            row = (await s.execute(text(
                f'WITH page AS ('
                f'  SELECT id, entity_id, content_hash FROM {_t(table)}'
                "   WHERE graph_id = :g AND commit_id = :c AND entity_id > :after"
                "   ORDER BY entity_id LIMIT :w"
                "), ins AS ("
                f'  INSERT INTO {_t("entity_heads")} '
                "    (graph_id, branch_id, entity_id, entity_kind, head_version_id,"
                "     content_hash, is_tombstone, updated_at)"
                "  SELECT :g, :b, entity_id, :kind, id, content_hash, false, :now FROM page"
                "  ON CONFLICT (graph_id, branch_id, entity_id) DO NOTHING"
                ") SELECT count(*), max(entity_id) FROM page"
            ).bindparams(g=graph_id, c=commit.id, b=main_id, after=after,
                         kind=("node" if kind == "nodes" else "edge"),
                         now=_now(), w=config.BOOTSTRAP_WINDOW))).one()
            n, last = int(row[0]), row[1]
            job = self._own(await s.get(JobORM, job_id))
            if n == 0:
                if kind == "nodes":
                    job.last_cursor = "heads:edges:"
                    job.updated_at = _now()
                    return False                               # switch to the edge pass
                return True                                    # both passes done
            job.last_cursor = f"heads:{kind}:{last}"
            job.progress = _PHASE_FLOOR["heads"]
            job.updated_at = _now()
        return False

    async def _phase_merkle(self, job_id: str, graph_id: str) -> bool:
        """The commit's Merkle root — the integrity fingerprint later commits inherit.

        Built inline while the tree fits in memory. Above the cap the root is left
        NULL (the column is expressly "async-filled for bulk") and the report SAYS so,
        rather than OOM-ing to produce a number nobody asked for yet."""
        async with self._session() as s:
            job = self._own(await s.get(JobORM, job_id))
            commit = await self._import_commit(s, graph_id)
            main_id = await self._main_branch_id(s, graph_id)
            total = int(job.total or 0)
            summary = dict(job.summary or {})
            report = dict(summary.get("report") or {})
            if total > config.BOOTSTRAP_MERKLE_INLINE_MAX:
                report["merkle"] = "deferred"
                summary["report"] = report
                job.summary = summary
                job.updated_at = _now()
                logger.info("bootstrap %s: merkle deferred (%d entities > cap)", job_id, total)
                return True
            changes: Dict[str, Optional[str]] = {}
            for table in ("node_versions", "edge_versions"):
                rows = (await s.execute(text(
                    f'SELECT entity_id, content_hash FROM {_t(table)} '
                    "WHERE graph_id = :g AND commit_id = :c"
                ).bindparams(g=graph_id, c=commit.id))).all()
                changes.update({r[0]: r[1] for r in rows})
            commit.merkle_root = await self._merkle.commit_tree(
                s, graph_id, main_id, commit.id, commit.commit_seq, changes)
            report["merkle"] = "inline"
            summary["report"] = report
            job.summary = summary
            job.progress = _PHASE_FLOOR["merkle"]
            job.updated_at = _now()
        return True

    async def _phase_finalize(self, job_id: str, graph_id: str) -> bool:
        """Flip the head — the single moment the versioned graph becomes real — and
        fast-forward the projection watermark instead of reseeding.

        The graph is pinned to the SOURCE FalkorDB graph the canvas already reads and
        validation just proved the two agree, so a full reseed would drop and rewrite
        every entity (and wipe the `:AGGREGATED` rollups) to arrive back where we are.
        """
        async with self._session() as s:
            job = self._own(await s.get(JobORM, job_id))
            graph = await s.get(GraphORM, graph_id)
            commit = await self._import_commit(s, graph_id)
            main = await s.get(BranchORM, await self._main_branch_id(s, graph_id))
            summary = dict(job.summary or {})
            stored = (summary.get("report") or {}).get("stored") or {}
            commit.stats = {"nodes": int(stored.get("nodes", 0)), "edges": int(stored.get("edges", 0))}
            main.head_commit_id = commit.id
            graph.main_head_commit_seq = commit.commit_seq
            graph.updated_at = _now()
            ps = await s.get(ProjectionStateORM, graph_id)
            if ps is not None:
                ps.projected_commit_seq = commit.commit_seq
                ps.target_commit_seq = commit.commit_seq
                ps.status = "idle"
                ps.last_projected_at = _now()
            job.target_commit_id = commit.id
            job.progress = _PHASE_FLOOR["finalize"]
            job.updated_at = _now()
        logger.info("bootstrap %s: head flipped to seq %s (projection fast-forwarded)",
                    job_id, commit.commit_seq)
        return True

    async def _phase_backfill(self, job_id: str, graph_id: str) -> bool:
        """Stamp the projector's delete-anchoring keys (`n.entityId`, `r.id`) onto the
        source graph, in ID-range windows. Additive and idempotent — a no-op on graphs
        the platform itself wrote. Runs before writes are unblocked, so the first
        incremental projection after enablement can anchor its deletes."""
        async with self._session() as s:
            job = await s.get(JobORM, job_id)
            ps = await s.get(ProjectionStateORM, graph_id)
            cursor = job.last_cursor or "backfill:nodes:0"
            width = config.BOOTSTRAP_SCAN_WIDTH
        parts = cursor.split(":")
        kind, lo = (parts[1], int(parts[2])) if len(parts) >= 3 else ("nodes", 0)
        client = await self._client(ps)
        max_id = await self._max_id(client, kind)
        if max_id is None or lo > max_id:
            if kind == "nodes":
                async with self._session() as s:
                    job = self._own(await s.get(JobORM, job_id))
                    job.last_cursor = "backfill:edges:0"
                    job.updated_at = _now()
                return False
            return True
        cypher = _BACKFILL_NODES if kind == "nodes" else _BACKFILL_EDGES
        await _q(client, cypher, {"lo": lo, "hi": lo + width}, timeout_ms=_WRITE_TIMEOUT_MS)
        async with self._session() as s:
            job = self._own(await s.get(JobORM, job_id))
            job.last_cursor = f"backfill:{kind}:{lo + width}"
            job.progress = _PHASE_FLOOR["backfill"]
            job.updated_at = _now()
        return False

    # ------------------------------------------------------------- internals --
    async def _max_id(self, client, kind: str = "nodes") -> Optional[int]:
        """The node id space — every phase (nodes, edges, backfill) windows over it."""
        res = await _q(client, _MAX_NODE_ID, timeout_ms=_READ_TIMEOUT_MS)
        rs = getattr(res, "result_set", None) or []
        val = rs[0][0] if rs and rs[0] else None
        return int(val) if val is not None else None

    async def _scan(self, client, kind: str, lo: int, width: int) -> Tuple[List[tuple], int]:
        """One window, halving on failure until it fits (a dense ID range, or one with fat
        property payloads, can blow the server's per-query budget).

        Returns the width that actually WORKED so the caller can remember it: rediscovering
        it from scratch every window means paying a failed query per window forever."""
        while True:
            try:
                res = await _q(client, _SCAN_NODES if kind == "nodes" else _SCAN_EDGES,
                               {"lo": lo, "hi": lo + width}, timeout_ms=_WRITE_TIMEOUT_MS)
                return list(getattr(res, "result_set", None) or []), width
            except Exception:
                if width <= config.BOOTSTRAP_SCAN_MIN_WIDTH:
                    raise
                width = max(config.BOOTSTRAP_SCAN_MIN_WIDTH, width // 2)
                logger.warning("bootstrap scan window shrank to %d (lo=%d)", width, lo)

    async def _known_nodes(self, graph_id: str, commit_id: str, urns) -> set:
        """Which endpoint urns already exist as imported nodes (node phase precedes the
        edge phase, so this is authoritative) — replaces the old in-memory urn→id map,
        which is what made the previous bootstrap O(graph) in RAM."""
        known: set = set()
        ids = [u for u in urns if u]
        async with self._session() as s:
            for batch in _chunks(ids, 10000):
                rows = (await s.execute(select(NodeVersionORM.entity_id).where(
                    NodeVersionORM.graph_id == graph_id,
                    NodeVersionORM.commit_id == commit_id,
                    NodeVersionORM.entity_id.in_(list(batch)),
                ))).scalars().all()
                known.update(rows)
        return known

    def _nodes_to_rows(self, rows, commit, main_id, graph_id, actor, rules, summary):
        from backend.app.providers.falkordb_provider import _node_from_props
        from backend.app.providers.versioned_bootstrap import canonicalize_rows
        now = _now()
        sample = _Reservoir(config.BOOTSTRAP_SAMPLE_K,
                            (summary.get("sample") or {}).get("nodes"),
                            (summary.get("sample") or {}).get("nodesSeen", 0))
        tallies: Dict[str, int] = {}
        rejects = {"duplicateUrns": 0, "samples": []}
        seen: set = set()
        dicts: List[dict] = []
        for labels, props in rows:
            node = _node_from_props(dict(props or {}), _label_of(labels))
            if node is None or not node.urn:
                continue                                   # filtered by the scan; belt-and-braces
            row = {"kind": "node", **node.model_dump(by_alias=True, exclude_none=True)}
            canonicalize_rows([row], rules)
            if not row.get("entityType"):
                row["entityType"] = _label_of(labels) or "unknown"
            eid = node.urn
            if eid in seen:
                rejects["duplicateUrns"] += 1
                _add_reject_sample(rejects, {"kind": "node", "id": eid,
                                             "reason": "another item shares this identifier"})
                continue
            seen.add(eid)
            payload = _sanitize_node_properties({k: v for k, v in row.items() if k != "kind"})
            ch = content_hash(payload)
            tallies[str(payload.get("entityType") or "unknown")] = \
                tallies.get(str(payload.get("entityType") or "unknown"), 0) + 1
            sample.offer(eid)
            dicts.append(dict(
                graph_id=graph_id, id=_vid("nvb", commit.id, eid), entity_id=eid,
                commit_id=commit.id, commit_seq=commit.commit_seq, branch_id=main_id,
                op="create", content_hash=ch, prev_content_hash=None, payload=payload,
                actor=actor, created_at=now, urn=payload.get("urn"),
                entity_type=payload.get("entityType"), display_name=payload.get("displayName"),
                qualified_name=payload.get("qualifiedName"),
            ))
        return dicts, tallies, rejects, {"nodes": sample.items, "nodesSeen": sample.seen}, 0

    def _edges_to_rows(self, rows, commit, main_id, graph_id, actor, rules, live: set):
        from backend.app.providers.falkordb_provider import _edge_from_row
        from backend.app.providers.versioned_bootstrap import canonicalize_rows
        now = _now()
        tallies: Dict[str, int] = {}
        rejects = {"danglingEdges": 0, "samples": []}
        dupes = 0
        seen: set = set()
        dicts: List[dict] = []
        for src_urn, tgt_urn, rel, props in rows:
            if not src_urn or not tgt_urn or src_urn not in live or tgt_urn not in live:
                rejects["danglingEdges"] += 1
                _add_reject_sample(rejects, {"kind": "edge", "reason": "endpoint item not found",
                                             "source": src_urn, "target": tgt_urn})
                continue
            edge = _edge_from_row(src_urn, tgt_urn, str(rel), dict(props or {}))
            row = {"kind": "edge", "id": edge.id, "edgeType": edge.edge_type,
                   "source": src_urn, "target": tgt_urn, **(edge.properties or {})}
            canonicalize_rows([row], rules)
            eid = edge.id
            if eid in seen:
                dupes += 1
                continue
            seen.add(eid)
            et = str(row.get("edgeType") or rel)
            payload = {"edgeType": et, "sourceEntityId": src_urn, "targetEntityId": tgt_urn,
                       **{k: v for k, v in row.items()
                          if k not in ("kind", "id", "source", "target", "edgeType")}}
            ch = content_hash(payload)
            tallies[et] = tallies.get(et, 0) + 1
            dicts.append(dict(
                graph_id=graph_id, id=_vid("evb", commit.id, eid), entity_id=eid,
                commit_id=commit.id, commit_seq=commit.commit_seq, branch_id=main_id,
                op="create", content_hash=ch, prev_content_hash=None, payload=payload,
                actor=actor, created_at=now, source_entity_id=src_urn, target_entity_id=tgt_urn,
                edge_type=et, confidence=payload.get("confidence"),
                discriminator=payload.get("discriminator"),
            ))
        return dicts, tallies, rejects, None, dupes

    async def _verify_sample(self, graph_id, commit_id, ps, urns, rules) -> Tuple[int, List[dict]]:
        """Re-read sampled entities from the SOURCE and compare content hashes with what
        we stored — the check that catches a mangled payload, which counts cannot."""
        if not urns:
            return 0, []
        from backend.app.providers.falkordb_provider import _node_from_props
        from backend.app.providers.versioned_bootstrap import canonicalize_rows
        client = await self._client(ps)
        res = await _q(client, _SAMPLE_NODES, {"urns": list(urns)}, timeout_ms=_READ_TIMEOUT_MS)
        fresh: Dict[str, str] = {}
        for labels, props in (getattr(res, "result_set", None) or []):
            node = _node_from_props(dict(props or {}), _label_of(labels))
            if node is None or not node.urn:
                continue
            row = {"kind": "node", **node.model_dump(by_alias=True, exclude_none=True)}
            canonicalize_rows([row], rules)
            if not row.get("entityType"):
                row["entityType"] = _label_of(labels) or "unknown"
            fresh[node.urn] = content_hash(
                _sanitize_node_properties({k: v for k, v in row.items() if k != "kind"}))
        async with self._session() as s:
            stored = dict((await s.execute(
                select(NodeVersionORM.entity_id, NodeVersionORM.content_hash).where(
                    NodeVersionORM.graph_id == graph_id,
                    NodeVersionORM.commit_id == commit_id,
                    NodeVersionORM.entity_id.in_(list(urns)),
                ))).all())
        matched, mismatched = 0, []
        for urn in urns:
            if urn in fresh and fresh[urn] == stored.get(urn):
                matched += 1
            else:
                mismatched.append({"entityId": urn,
                                   "reason": "changed in the source while copying"
                                             if urn in fresh else "no longer in the source"})
        return matched, mismatched

    async def _import_commit(self, s, graph_id: str) -> CommitORM:
        commit = (await s.execute(select(CommitORM).where(
            CommitORM.graph_id == graph_id,
            CommitORM.idempotency_key == f"bootstrap:{graph_id}",
        ))).scalars().first()
        if commit is None:                                     # pragma: no cover - guarded at enqueue
            raise BootstrapFailure("the import commit is missing", "internal")
        return commit

    async def _main_branch_id(self, s, graph_id: str) -> str:
        return (await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalars().one()


# --------------------------------------------------------------------------- #
# Job lifecycle (API-facing): enqueue, status, retry, abandon                   #
# --------------------------------------------------------------------------- #
async def create_bootstrap_job(
    *, data_source_id: str, workspace_id: str, actor: str,
    falkor_graph_name: Optional[str] = None, falkor_provider: Optional[str] = None,
    kind: str = "manual",
) -> Dict[str, object]:
    """Enqueue "enable version control" for a data source. Idempotent.

    Creates the graph shell (genesis + main + projection state) and the seq-2 `import`
    commit the worker fills in — but NEVER advances the head, so the data source keeps
    reading its live graph and simply isn't versioned yet until the job finishes.

    The projection watermark is parked at genesis (`projected == target == 1`) on
    purpose: the graph is pinned to the SOURCE FalkorDB graph, so a projector that
    thought it had work to do would DROP that graph and reseed it from an empty
    genesis — i.e. wipe the user's data. Nothing may project until finalize.
    """
    svc = GraphVersioningService()
    async with db.graphver_session() as s:
        graph = (await s.execute(select(GraphORM).where(
            GraphORM.data_source_id == data_source_id))).scalars().first()

        if graph is not None:
            if graph.kind == "blank":
                raise ValueError("blank models start empty by design; there is nothing to import")
            if graph.main_head_commit_seq > 1:
                return {"graph_id": graph.id, "already_enabled": True}
            job = (await s.execute(select(JobORM).where(
                JobORM.job_type == BOOTSTRAP_JOB_TYPE, JobORM.graph_id == graph.id,
            ).order_by(JobORM.created_at.desc()))).scalars().first()
            if job is not None:
                if job.status in ("pending", "running"):
                    return {"graph_id": graph.id, "job_id": job.id, "status": job.status}
                job.status = "pending"                    # failed/cancelled → resume in place
                job.error_message = None
                job.updated_at = _now()
                return {"graph_id": graph.id, "job_id": job.id, "status": "pending"}
            main_id = await _main_branch(s, graph.id)
            gid = graph.id
        else:
            res = await svc.create_graph(
                data_source_id=data_source_id, workspace_id=workspace_id, kind=kind,
                actor=actor, falkor_graph_name=falkor_graph_name,
                falkor_provider=falkor_provider, session=s)
            gid, main_id = res["graph_id"], res["main_branch_id"]

        await s.flush()                                   # create_graph's rows are still pending
        ps = await s.get(ProjectionStateORM, gid)
        if ps is not None:
            ps.projected_commit_seq = 1                   # see docstring — never project mid-bootstrap
            ps.target_commit_seq = 1
        commit = await _ensure_import_commit(s, gid, main_id, actor)
        job = JobORM(
            job_type=BOOTSTRAP_JOB_TYPE, graph_id=gid, workspace_id=workspace_id,
            data_source_id=data_source_id, branch_id=main_id, status="pending",
            current_phase="counting", idempotency_key=f"bootstrap:{gid}",
            batch_size=config.BOOTSTRAP_SCAN_WIDTH, target_commit_id=commit.id,
            summary={"actor": actor},
        )
        s.add(job)
        await s.flush()
        return {"graph_id": gid, "job_id": job.id, "status": "pending"}


async def bootstrap_status(
    *, data_source_id: str, workspace_id: Optional[str] = None,
) -> Optional[Dict[str, object]]:
    """The data source's latest enablement job, in the shape the UI polls.

    ``workspace_id`` scopes the lookup for tenant isolation — a graph must belong to the
    workspace in the URL, and existence isn't leaked across tenants (the rest of the
    versioning API enforces the same rule via ``graph_in_workspace``)."""
    async with db.graphver_session() as s:
        conds = [JobORM.job_type == BOOTSTRAP_JOB_TYPE,
                 JobORM.data_source_id == data_source_id]
        if workspace_id is not None:
            conds.append(JobORM.workspace_id == workspace_id)
        job = (await s.execute(select(JobORM).where(*conds
        ).order_by(JobORM.created_at.desc()))).scalars().first()
        if job is None:
            return None
        summary = job.summary or {}
        return {
            "jobId": job.id, "graphId": job.graph_id, "status": job.status,
            "phase": job.current_phase, "processed": int(job.processed or 0),
            "total": int(job.total or 0), "percent": int(job.progress or 0),
            "startedAt": job.started_at, "updatedAt": job.updated_at,
            "error": job.error_message,
            "report": summary.get("report") if job.status in ("completed", "failed") else None,
        }


async def retry_bootstrap(*, data_source_id: str, mode: str = "resume") -> Dict[str, object]:
    """``resume`` picks up from the last committed window; ``restart`` throws away what
    was imported and re-reads the source from scratch (for a source that changed
    mid-copy). Neither can touch a graph whose head already flipped."""
    async with db.graphver_session() as s:
        job = (await s.execute(select(JobORM).where(
            JobORM.job_type == BOOTSTRAP_JOB_TYPE, JobORM.data_source_id == data_source_id,
        ).order_by(JobORM.created_at.desc()))).scalars().first()
        if job is None:
            raise ValueError("no enablement job for this data source")
        if job.status == "completed":
            return {"jobId": job.id, "status": "completed"}
        graph = await s.get(GraphORM, job.graph_id)
        if graph is not None and graph.main_head_commit_seq > 1:
            return {"jobId": job.id, "status": "completed"}
        if mode == "restart":
            commit_id = job.target_commit_id
            for table in ("node_versions", "edge_versions"):
                await s.execute(text(
                    f'DELETE FROM {_t(table)} WHERE graph_id = :g AND commit_id = :c'
                ).bindparams(g=job.graph_id, c=commit_id))
            await s.execute(text(
                f'DELETE FROM {_t("entity_heads")} WHERE graph_id = :g AND branch_id = :b'
            ).bindparams(g=job.graph_id, b=job.branch_id))
            job.current_phase = "counting"
            job.summary = {"actor": (job.summary or {}).get("actor", "system")}
            job.processed = 0
            job.progress = 0
        job.last_cursor = None if mode == "restart" else job.last_cursor
        job.status = "pending"
        job.error_message = None
        job.updated_at = _now()
        return {"jobId": job.id, "status": "pending", "mode": mode}


async def abandon_bootstrap(*, data_source_id: str) -> Dict[str, object]:
    """Give up on enablement and leave the data source exactly as it was: the graph shell
    and everything the job imported are removed, so it reads as un-versioned again.
    Refuses once the head has flipped (that graph is live — use the versioning UI).

    Safe to call while a worker is mid-copy. ``status='cancelled'`` and the deletes land in
    ONE transaction, and every worker write re-reads the job in its own transaction and
    aborts if the job is cancelled (``BootstrapRunner._own``) — so the worker either
    committed its window before us (and we delete those rows too) or rolls back after us.
    It cannot commit rows into a graph we have deleted."""
    async with db.graphver_session() as s:
        job = (await s.execute(select(JobORM).where(
            JobORM.job_type == BOOTSTRAP_JOB_TYPE, JobORM.data_source_id == data_source_id,
        ).order_by(JobORM.created_at.desc()).with_for_update())).scalars().first()
        if job is None:
            raise ValueError("no enablement job for this data source")
        if job.status == "cancelled":
            return {"jobId": job.id, "status": "cancelled"}
        graph = await s.get(GraphORM, job.graph_id)
        if graph is not None and graph.main_head_commit_seq > 1:
            raise ConcurrencyError("version control is already enabled for this data source")
        job.status = "cancelled"                  # fences the worker (see _own)
        job.updated_at = _now()
        gid = job.graph_id
        for table in ("node_versions", "edge_versions", "merkle_nodes", "working_changes"):
            await s.execute(text(f'DELETE FROM {_t(table)} WHERE graph_id = :g').bindparams(g=gid))
        for table in ("entity_heads", "commits", "branches", "projection_state"):
            await s.execute(text(f'DELETE FROM {_t(table)} WHERE graph_id = :g').bindparams(g=gid))
        if graph is not None:
            await s.delete(graph)
        logger.info("bootstrap %s abandoned; graph %s removed", job.id, gid)
        return {"jobId": job.id, "status": "cancelled"}


async def _ensure_import_commit(s, graph_id: str, main_id: str, actor: str) -> CommitORM:
    """The seq-2 ``import`` commit the windows write into. Created up front (head stays
    at genesis) so every version row has its commit, and idempotent on re-enqueue."""
    commit = (await s.execute(select(CommitORM).where(
        CommitORM.graph_id == graph_id,
        CommitORM.idempotency_key == f"bootstrap:{graph_id}",
    ))).scalars().first()
    if commit is not None:
        return commit
    branch = await s.get(BranchORM, main_id)
    commit = CommitORM(
        graph_id=graph_id, branch_id=main_id, commit_seq=2,
        parent_commit_id=branch.head_commit_id, kind="import",
        message="enable version control", actor=actor,
        idempotency_key=f"bootstrap:{graph_id}",
    )
    s.add(commit)
    await s.flush()
    return commit


async def _main_branch(s, graph_id: str) -> str:
    return (await s.execute(select(BranchORM.id).where(
        BranchORM.graph_id == graph_id, BranchORM.kind == "main"))).scalars().one()


# --------------------------------------------------------------------------- #
# Errors + helpers                                                             #
# --------------------------------------------------------------------------- #
class BootstrapFailure(Exception):
    """A job failed for a reason we can explain to the user in plain language."""

    def __init__(self, reason: str, code: str = "integrity"):
        super().__init__(reason)
        self.reason, self.code = reason, code


class BootstrapSuperseded(Exception):
    """We no longer own this job — another worker took it over, or the user abandoned it.
    Not a failure: the write that discovered it rolls back, and we simply stop."""


def _explain_failed_checks(failed: List[dict]) -> str:
    """Most specific, most actionable cause first. A data-quality problem in the source
    also trips the generic "didn't match" checks (a duplicate identifier, for instance,
    makes the re-read sample disagree too) — saying "the graph changed" there would send
    the user chasing the wrong thing."""
    keys = {c["key"] for c in failed}
    if "no_duplicate_items" in keys:
        return ("Some items in the source graph share an identifier. Version history needs "
                "unique identifiers — de-duplicate them and try again.")
    if {"no_dropped_connections", "referentially_whole"} & keys:
        return ("Some connections point at items that don't exist in the source graph, so the "
                "copy would lose them.")
    if {"nodes_seen", "edges_seen", "sample_matches"} & keys:
        return ("The source graph changed while we were copying it, so the copy can't be "
                "trusted. Retry when the graph is quiet.")
    return "The copy didn't match the source graph exactly, so it was not applied."


def _friendly_infra_error(exc: Exception) -> str:
    return ("We couldn't finish reading the source graph — the graph service may be busy or "
            f"unavailable. You can resume this safely. ({type(exc).__name__})")


def _tally_matches(pg: Dict[str, int], src: Dict[str, int], *, allow_lower: bool = False) -> bool:
    """Every source type is present with the right count. `allow_lower` tolerates the
    parallel-connection merge (indistinguishable duplicates the read layer also merges)."""
    for k, v in src.items():
        got = int(pg.get(k, 0))
        if got == int(v):
            continue
        if allow_lower and 0 < got < int(v):
            continue
        return False
    return True


def _add_reject_sample(rejects: dict, item: dict) -> None:
    if len(rejects.get("samples") or []) < 10:
        rejects.setdefault("samples", []).append(item)


def _merge_scan_summary(summary: dict, kind: str, *, scanned: int, written: int,
                        tallies: dict, rejects: dict, sample, dupes: int) -> dict:
    sc = dict(summary.get("scanned") or {"nodes": 0, "edges": 0, "byLabel": {}, "byType": {}})
    wr = dict(summary.get("written") or {"nodes": 0, "edges": 0})
    rj = dict(summary.get("rejected") or {"duplicateUrns": 0, "danglingEdges": 0, "samples": []})
    sc[kind] = int(sc.get(kind, 0)) + scanned
    wr[kind] = int(wr.get(kind, 0)) + written
    bucket = "byLabel" if kind == "nodes" else "byType"
    agg = dict(sc.get(bucket) or {})
    for k, v in (tallies or {}).items():
        agg[k] = agg.get(k, 0) + v
    sc[bucket] = agg
    for k in ("duplicateUrns", "danglingEdges"):
        rj[k] = int(rj.get(k, 0)) + int((rejects or {}).get(k, 0))
    for s in (rejects or {}).get("samples") or []:
        _add_reject_sample(rj, s)
    summary["scanned"], summary["written"], summary["rejected"] = sc, wr, rj
    summary["collapsedParallelEdges"] = int(summary.get("collapsedParallelEdges", 0)) + int(dupes or 0)
    if sample is not None:
        summary["sample"] = sample
    return summary


def _percent(kind: str, processed: int, total: Optional[int]) -> int:
    if not total:
        return _PHASE_FLOOR[kind]
    frac = min(1.0, max(0.0, processed / float(total)))
    return int(_PHASE_FLOOR["nodes"] + frac * _SCAN_SPAN)


def _next_phase(phase: str) -> Optional[str]:
    i = PHASES.index(phase)
    return PHASES[i + 1] if i + 1 < len(PHASES) else None


def _t(table: str) -> str:
    return f'"{config.graphver_schema()}"."{table}"'


def _now_minus(secs: int) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(seconds=secs)).isoformat()


async def _ontology_rules(job_id: str):
    """The data source's assigned ontology rules, so OUR copy is written in canonical
    casing from its first commit (same seed canonicalization the old path did). None
    when no ontology is explicitly assigned — legacy graphs are never retro-gated."""
    async with db.graphver_session() as s:
        job = await s.get(JobORM, job_id)
        ds_id, ws_id = (job.data_source_id, job.workspace_id) if job else (None, None)
    if not ds_id:
        return None
    try:
        from backend.app.db.engine import get_async_session
        from backend.app.db.repositories.data_source_repo import get_data_source_orm
        from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
        from backend.app.ontology.rules import resolved_ontology_to_rules
        from backend.app.ontology.service import LocalOntologyService
        async with get_async_session() as s:
            ds = await get_data_source_orm(s, ds_id)
            if ds is None or not ds.ontology_id:
                return None
            ont = LocalOntologyService(SQLAlchemyOntologyRepository(s))
            resolved = await ont.resolve(workspace_id=ws_id, data_source_id=ds_id)
            return resolved_ontology_to_rules(resolved)
    except Exception:                                          # pragma: no cover - best effort
        logger.exception("bootstrap %s: ontology rules unavailable; using source spellings", job_id)
        return None
