"""Central, env-driven configuration for the versioning store.

Nothing in the versioning layer hardcodes a tunable — every knob lives here and
is overridable via an environment variable.  Settings fall into two classes, and
mixing them up is a correctness trap, so they are labelled:

* **IMMUTABLE-AFTER-DATA** — fixes the on-disk encoding.  Changing it after rows
  exist invalidates existing hashes or partitions and must be treated like a
  schema migration: ``HASH_ALGO``, ``HASH_DIGEST_SIZE``, ``MERKLE_DEPTH``,
  ``PARTITIONS``.
* **RUNTIME-TUNABLE** — safe to change between restarts: DB URL, pool sizing,
  batch sizes, draft TTL, default audit tier, ephemeral-pool caps.

Pure stdlib so every other module (including the dependency-free Merkle core)
can import it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os

# In-graph bookkeeping nodes that live in a FalkorDB cache graph but are NOT
# committed-main entities: the projector's rollup watermark, the aggregation
# pipeline's run stamp, and the dedicated-projection scaffolding. They are the
# projector's and the aggregation worker's own output, so every comparison of a
# cache graph against committed main must exclude them. ONE definition, shared
# — see the module docstring there for the two separate outages a second copy
# of this list caused.
from backend.common.derived_artifacts import (  # noqa: F401  (re-export)
    DERIVED_LABELS,
    not_derived_clause,
)

# --------------------------------------------------------------------------- #
# Store / decoupling (RUNTIME-TUNABLE)                                         #
# --------------------------------------------------------------------------- #
_DEV_FALLBACK_URL = "postgresql+asyncpg://synodic:synodic@localhost:5432/synodic"


def graphver_db_url() -> str:
    """Resolve the versioning store URL.

    The store is *decoupled* (plan §1): point ``GRAPHVER_DB_URL`` at its own
    CloudSQL instance in production.  When unset it falls back to
    ``MANAGEMENT_DB_URL`` (single-instance dev), then to the local dev DSN.
    """
    return (
        os.getenv("GRAPHVER_DB_URL")
        or os.getenv("MANAGEMENT_DB_URL")
        or _DEV_FALLBACK_URL
    )


def graphver_schema() -> str:
    return os.getenv("GRAPHVER_SCHEMA", "graphver")


# --------------------------------------------------------------------------- #
# IMMUTABLE-AFTER-DATA                                                         #
# --------------------------------------------------------------------------- #
# Number of hash partitions for the high-cardinality append-only tables.
# Fixed modulo hash (plan §16.5 #2) — never a partition-per-data-source.
PARTITIONS: int = int(os.getenv("GRAPHVER_PARTITIONS", "64"))

# Merkle trie depth (16-way per level → 16**depth leaf buckets).
MERKLE_DEPTH: int = int(os.getenv("GRAPHVER_MERKLE_DEPTH", "4"))

# Content/Merkle hash. Cryptographic by design (integrity) — blake2b (stdlib)
# by default; "blake3" if the optional wheel is installed.  We fail fast rather
# than silently downgrade, because a mismatch would corrupt hash continuity.
HASH_ALGO: str = os.getenv("GRAPHVER_HASH_ALGO", "blake2b").lower()
HASH_DIGEST_SIZE: int = int(os.getenv("GRAPHVER_HASH_DIGEST_SIZE", "32"))


def new_hash():
    """Return a fresh hash object for the configured algorithm."""
    if HASH_ALGO == "blake2b":
        return hashlib.blake2b(digest_size=HASH_DIGEST_SIZE)
    if HASH_ALGO == "blake3":
        try:
            import blake3  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on optional wheel
            raise RuntimeError(
                "GRAPHVER_HASH_ALGO=blake3 but the 'blake3' package is not "
                "installed. Install it or set GRAPHVER_HASH_ALGO=blake2b. "
                "Do NOT switch algorithms once data exists."
            ) from exc
        return blake3.blake3()
    raise RuntimeError(f"Unsupported GRAPHVER_HASH_ALGO={HASH_ALGO!r} (blake2b|blake3)")


def hash_parts(*parts: bytes) -> str:
    """Length-prefixed digest over *parts*.

    Length-prefixing makes concatenation unambiguous: ``hash_parts(b"ab", b"c")``
    differs from ``hash_parts(b"a", b"bc")``.  Used for both content hashes and
    Merkle node hashes so the whole tree shares one algorithm.
    """
    h = new_hash()
    for p in parts:
        h.update(len(p).to_bytes(8, "big"))
        h.update(p)
    return h.hexdigest()


def empty_hash() -> str:
    """Sentinel hash for an absent Merkle child/bucket (algorithm-sized zeros)."""
    return "0" * (len(hash_parts(b"")) )


# --------------------------------------------------------------------------- #
# RUNTIME-TUNABLE                                                              #
# --------------------------------------------------------------------------- #
# Connection pool for the graphver engine.
POOL_SIZE: int = int(os.getenv("GRAPHVER_POOL_SIZE", "10"))
POOL_MAX_OVERFLOW: int = int(os.getenv("GRAPHVER_POOL_MAX_OVERFLOW", "5"))
POOL_TIMEOUT_SECS: int = int(os.getenv("GRAPHVER_POOL_TIMEOUT_SECS", "10"))
# The small pool of its own that routes every read of a versioned graph (its pin, its watermark, its
# main branch; ``db.get_route_engine``): apart from the pool above, so reads that fill that one
# can't take routing down with them. Each statement on it is cut off past two seconds.
ROUTE_POOL_SIZE: int = int(os.getenv("GRAPHVER_ROUTE_POOL_SIZE", "3"))
ROUTE_POOL_MAX_OVERFLOW: int = int(os.getenv("GRAPHVER_ROUTE_POOL_MAX_OVERFLOW", "2"))
ROUTE_POOL_TIMEOUT_SECS: int = int(os.getenv("GRAPHVER_ROUTE_POOL_TIMEOUT_SECS", "2"))

# Bulk ingest / projection batch sizes (rows per COPY / UNWIND chunk).
INGEST_BATCH_SIZE: int = int(os.getenv("GRAPHVER_INGEST_BATCH_SIZE", "5000"))
PROJECTION_BATCH_SIZE: int = int(os.getenv("GRAPHVER_PROJECTION_BATCH_SIZE", "5000"))
# A projector statement that times out (or meets the memory ceiling) is split in half and the halves
# sent again, down to one row; this many retries at one row, backing off 2 s, 4 s, 8 s (plus jitter)
# between them, before the row is given up on. The width that worked is kept per graph and statement
# kind, and grows back by a quarter after eight quick statements, never past PROJECTION_BATCH_SIZE.
PROJECTION_FLOOR_RETRIES: int = int(os.getenv("GRAPHVER_PROJECTION_FLOOR_RETRIES", "3"))
# project_now (right after a publish or merge, inside the request) projects a window of at most this many
# version rows itself; a larger one is left to the projection worker, which a nudge wakes. Its 10 s budget
# would otherwise cancel the pass while FalkorDB still ran its last write.
PROJECTION_INLINE_MAX_ROWS: int = int(os.getenv("GRAPHVER_PROJECTION_INLINE_MAX_ROWS", "20000"))
# A projector statement that still fails for one entity on its own, after its retries, is held in
# projection_quarantine and the rest of its window publishes; later passes retry it first. Off: such an
# entity fails the pass, and every pass after it, as before.
PROJECTION_QUARANTINE: bool = os.getenv("GRAPHVER_PROJECTION_QUARANTINE", "1").lower() not in ("0", "false", "no")
# A caught-up graph holding quarantined entities is given a pass of its own to retry them once each try is
# this old; a graph taking commits retries them first on every pass.
PROJECTION_QUARANTINE_RETRY_SECS: int = int(os.getenv("GRAPHVER_PROJECTION_QUARANTINE_RETRY_SECS", "300"))
# A pass over a window too large to hold (paged) or a rebuild too large to hold (streamed) stops at the
# first page boundary past this many seconds: its cursor is on the pass marker, it publishes nothing,
# records no error and no backoff, and nudges itself, so the next pass resumes after the last page. Other
# graphs get their turn meanwhile. 0: no limit.
PROJECTION_PASS_MAX_SECS: float = float(os.getenv("GRAPHVER_PROJECTION_PASS_MAX_SECS", "300"))
# A graph that cannot be brought up to date by its windows is rebuilt in place on its own: when its verify
# finds FalkorDB short of committed main, or (a key the platform minted) holding more after the tombstone
# sweep, and when the same window has failed ESCALATE_AFTER passes in a row on a timeout or memory refusal
# the statement ladder could not absorb. Off: the old inline heal, and a graph held back until a rebuild.
PROJECTION_ESCALATE: bool = os.getenv("GRAPHVER_PROJECTION_ESCALATE", "1").lower() not in ("0", "false", "no")
PROJECTION_ESCALATE_AFTER: int = int(os.getenv("GRAPHVER_PROJECTION_ESCALATE_AFTER", "3"))

# Projection worker: poll cadence for the reconciling loop, read freshness
# tolerance (a read serves from FalkorDB while projected >= committed - lag),
# the worker's health port, and whether the web process also runs the poll loop.
PROJECTION_POLL_SECS: int = int(os.getenv("GRAPHVER_PROJECTION_POLL_SECS", "5"))
# Max graphs projected concurrently per reconciling poll pass (each id appears once per pass,
# so there's no same-graph race) — keeps the worker caught up across 100s of graphs.
PROJECTION_CONCURRENCY: int = int(os.getenv("GRAPHVER_PROJECTION_CONCURRENCY", "8"))
# The poll retries a failed pass after BASE seconds, doubling per consecutive failure up to MAX.
# A publish (its nudge) and project_now retry at once regardless.
PROJECTION_RETRY_BASE_SECS: int = int(os.getenv("GRAPHVER_PROJECTION_RETRY_BASE_SECS", "5"))
PROJECTION_RETRY_MAX_SECS: int = int(os.getenv("GRAPHVER_PROJECTION_RETRY_MAX_SECS", "900"))
# A publishing pass writes its _GVProjMeta marker last and, with WAIT_REPLICAS > 0, WAITs on that
# write's own connection: fewer replicas acknowledging within WAIT_MS hold the watermark
# (replica_unconfirmed) and back off. 0 sends no WAIT (dev, CI, an instance without replicas).
# Read by the web pods too: project_now and rebuild_now run passes in-process.
PROJECTION_WAIT_REPLICAS: int = int(os.getenv("GRAPHVER_PROJECTION_WAIT_REPLICAS", "0"))
PROJECTION_WAIT_MS: int = int(os.getenv("GRAPHVER_PROJECTION_WAIT_MS", "2000"))
# Every LIVENESS_SECS the projection lane reads each idle graph's marker: a missing key resets its
# watermark to 0, a marker behind it to the marker's seq, and the poll reseeds. A key no summaries
# build has stamped gets its first one asked for. 0 turns it off.
LIVENESS_SECS: int = int(os.getenv("GRAPHVER_LIVENESS_SECS", "60"))
# How many versions behind main's head a read of main may be served from the FalkorDB key while
# the projection catches up or rebuilds in place (``serving_seq``): the version the key last
# published, complete with its lineage summaries, and the view says the graph is being updated.
# -1 (the default): however far behind. 0: the head only, as before, so a read the key is behind
# for goes to Postgres, which composes the graph without its lineage summaries.
READ_MAX_LAG: int = int(os.getenv("GRAPHVER_READ_MAX_LAG", "-1"))
# What reads of a versioned graph's main get while a newer version is being written into FalkorDB,
# unless the graph says otherwise (``projection_state.read_mode``). A system administrator changes it
# live under Admin → Infrastructure → Versioned graphs → New-version builds (``build_policy``).
#   latest    always the newest published version: from Postgres until FalkorDB holds it. The
#             default: reads of a graph behind its head have always gone to Postgres;
#   in_place  the version FalkorDB last finished, while the next is written into the same key;
#   beside    exactly that version, while the next is built in a second key, then one switch
#             (with New-version builds off, ``candidateKeysEnabled``, it reads as in_place).
READ_MODES = ("latest", "in_place", "beside")
READ_MODE: str = os.getenv("GRAPHVER_READ_MODE", "latest")
if READ_MODE not in READ_MODES:
    READ_MODE = "latest"
# After each projection, cheaply reconcile live node/edge COUNTS between Postgres
# (the SoR) and FalkorDB (the cache); on a mismatch, bounded-heal by reseeding the
# graph from Postgres once. Guards against a silently dropped delete leaving the
# cache diverged from committed main. Disable with GRAPHVER_PROJECTION_VERIFY=0.
PROJECTION_VERIFY_ENABLED: bool = os.getenv("GRAPHVER_PROJECTION_VERIFY", "1").lower() not in ("0", "false", "no")
# How often, per graph, a pass that applied only main's newest commits counts the whole graph in
# both stores (the verify above). Every pass did, so a graph taking a commit every few seconds
# counted itself every few seconds (doc 19 §3.8). Always verified, whatever the interval:
# - a full seed;
# - a pass that dropped a write;
# - a graph whose last verify healed or failed;
# - a key with recorded drift;
# - the first pass in a process.
# A delta dropped silently between verifies is caught by the next one. 0: verify every pass, as
# before.
PROJECTION_VERIFY_INTERVAL_SECS: float = float(os.getenv("GRAPHVER_PROJECTION_VERIFY_INTERVAL_SECS", "300"))
# On a FULL SEED (an explicit rebuild / first seed / repin), also run a CONTENT verify that catches
# what the count verify can't: an edge reseeded with a dropped confidence / blanked properties / wrong
# type, or a node with a drifted displayName or label. It rides the SAME single ordered scan the
# id-set diff already streams (comparing fields on matched ids), so it is O(N+E) — NOT the O(N²+E²)
# per-entity fetch it used to do, which hung a 60k rebuild for minutes and drove a DROP+reseed
# wipe-loop. On any drift the rebuild is held back (watermark not advanced) so reads keep serving
# Postgres. Disable with GRAPHVER_PROJECTION_VERIFY_DEEP=0 (the collapse-correct DISTINCT-triple count
# verify still runs and holds back on a dropped/extra entity).
PROJECTION_VERIFY_DEEP: bool = os.getenv("GRAPHVER_PROJECTION_VERIFY_DEEP", "1").lower() not in ("0", "false", "no")
# Scale ceiling for the deep field verify on the hot path. The scan pages with SKIP/LIMIT (~O(N²/batch)
# to re-sort each page on the unindexed entityId ordering), so above this many entities the deep pass
# is skipped on the automatic rebuild (count verify still runs); the on-demand reconcile ("Check sync")
# can still deep-diff any size when an operator explicitly asks. 0 disables the ceiling.
PROJECTION_VERIFY_DEEP_MAX_ENTITIES: int = int(os.getenv("GRAPHVER_PROJECTION_VERIFY_DEEP_MAX_ENTITIES", "500000"))
# Largest restructure whose rollups the projector moves itself, by delta: a moved container's subtree
# (and the lineage edges under it), and a reconcile's lineage-edge contributions. Past this the
# aggregation batch job — which also writes only the difference — takes over. A publish window's own
# lineage edges have no such cap (ROLLUP_NET_MAX_CELLS below).
PROJECTION_ROLLUP_INLINE_CAP: int = int(os.getenv("GRAPHVER_PROJECTION_ROLLUP_INLINE_CAP", "50000"))
# A window's lineage summaries are moved by delta whatever its size: its edges are read a page at a time
# (PROJECTION_PAGE) and their contributions netted by cell, in memory up to this many cells and in
# graphver.rollup_deltas past it, then applied a page at a time. (The inline cap above still bounds a
# MOVED container's subtree: a move of more than that goes to the aggregation job.)
ROLLUP_NET_MAX_CELLS: int = int(os.getenv("GRAPHVER_ROLLUP_NET_MAX_CELLS", "200000"))
# A lineage-summaries build the projector asked for and did not get (a job already running, which may
# have read the graph before the change that asked; a hold; the service out of reach) is asked for
# again by the liveness loop, at most this often per graph, until one is queued
# (projection_state.rollup_state). 0: never again.
ROLLUP_REASK_SECS: int = int(os.getenv("GRAPHVER_ROLLUP_REASK_SECS", "300"))
# A projection window of more version rows than this (a publish of millions) is written a page of
# PROJECTION_PAGE rows at a time — all its nodes, then its edges — so the projector holds a page of
# it, never all of it. Its rollups are moved by delta like any window's (ROLLUP_NET_MAX_CELLS).
# Held whole, a window costs about 1.8 KB a row (463 MB at 200,000 in the versioning-scale run);
# paged, about 230 MB at any size.
PROJECTION_PAGED_ABOVE: int = int(os.getenv("GRAPHVER_PROJECTION_PAGED_ABOVE", "100000"))
PROJECTION_PAGE: int = int(os.getenv("GRAPHVER_PROJECTION_PAGE", "20000"))
# A full reconcile (a first seed, a rebuild, a heal) holds both sides of a graph — what Postgres
# says and what FalkorDB holds — about 2.8 KB a live entity (667 MB at 200,000 in the
# versioning-scale run). Above this many live entities it compares them a page at a time, about
# 230 MB at any size, and hands the lineage summaries to the aggregation job when anything changed.
PROJECTION_RECONCILE_STREAMED_ABOVE: int = int(os.getenv("GRAPHVER_PROJECTION_RECONCILE_STREAMED_ABOVE",
                                                         "100000"))
WORKER_HEALTH_PORT: int = int(os.getenv("GRAPHVER_WORKER_HEALTH_PORT", "8092"))
PROJECTION_INPROCESS: bool = os.getenv("GRAPHVER_PROJECTION_INPROCESS", "").lower() in ("1", "true", "yes")
# Ceiling for an EXPLICIT operator rebuild run in-process (Data health → "Rebuild"):
# a full reseed is O(whole main graph), so it gets a generous budget — unlike the
# interactive 10s post-write catch-up, which stays snappy and defers to the worker.
REBUILD_SYNC_TIMEOUT_SECS: int = int(os.getenv("GRAPHVER_REBUILD_TIMEOUT_SECS", "900"))

# Provider write-through: record every graph write as an audited versioned commit on the
# data source's versioned graph (the audit trail + branch/version history, on by default).
# Set GRAPHVER_VERSIONED_WRITES=0 to opt out data sources that are not versioned (their writes
# then hit the provider only); a versioned graph is always written through versioning.
VERSIONED_WRITES_ENABLED: bool = os.getenv("GRAPHVER_VERSIONED_WRITES", "1").lower() not in ("0", "false", "no")

# Evictable/rebuildable FalkorDB cache (plan §5, §16.5 #9-10): single-flight
# rebuild lock TTL and read-lease (refcount) TTL, both seconds.
REBUILD_LOCK_TTL: int = int(os.getenv("GRAPHVER_REBUILD_LOCK_TTL", "120"))
LEASE_TTL: int = int(os.getenv("GRAPHVER_LEASE_TTL", "60"))

# Per-provider RAM-budget eviction of cold FalkorDB main caches (plan §16.5 #9-10):
# RAM is a property of a FalkorDB instance, so each provider has its OWN resident
# budget — not one limit across all graphs globally. The eviction worker takes a
# provider_id -> budget resolver (injected, so the store stays decoupled from the
# provider registry); the helpers below are the default env-backed resolver.
#   GRAPHVER_FALKOR_MAX_RESIDENT  default budget applied to every provider
#   GRAPHVER_FALKOR_BUDGETS       JSON {provider_id: budget} per-provider overrides
# A budget of 0 means "unlimited" for that provider (the daemon skips it); the
# daemon is off entirely unless at least one budget is configured.
FALKOR_MAX_RESIDENT: int = int(os.getenv("GRAPHVER_FALKOR_MAX_RESIDENT", "0"))
FALKOR_BUDGETS: dict = json.loads(os.getenv("GRAPHVER_FALKOR_BUDGETS", "") or "{}")
DEFAULT_FALKOR_PROVIDER: str = "default"
# A moved graph's old platform key is dropped no sooner than this after the move, and only once the
# new key has caught up (doc 14 §6) — until then a move back onto it reconciles in place. The
# default for New-version builds' retire grace (``build_policy``), which an administrator overrides.
RETIRE_GRACE_SECS: int = int(os.getenv("GRAPHVER_RETIRE_GRACE_SECS", "900"))

# New-version builds (doc 14 §6, ``build_policy``): a graph's next version built in a second key
# while its current key keeps serving, then switched to. Each value below is a default that a system
# administrator overrides live under Admin → Infrastructure → New-version builds; the switch itself
# is the ``candidateKeysEnabled`` feature flag. Windows of more changed rows than this are built
# beside the serving key, as are rebuilds, moves and loads of platform-owned keys when enabled.
PROJECTION_CANDIDATE_ABOVE: int = int(os.getenv("GRAPHVER_PROJECTION_CANDIDATE_ABOVE", "200000"))
PROJECTION_CANDIDATE_REBUILDS: bool = os.getenv("GRAPHVER_PROJECTION_CANDIDATE_REBUILDS", "1") == "1"
# How a build makes its key: ``auto`` copies the serving key (GRAPH.COPY) when its node has room,
# else seeds it from Postgres on the node with most room; ``copy`` and ``reseed`` force one way.
PROJECTION_CANDIDATE_MODE: str = os.getenv("GRAPHVER_PROJECTION_CANDIDATE_MODE", "auto")
# The free memory a copy needs on its node, as a share of the graph's size (130 = ×1.3), and the
# largest graph copied rather than reseeded (0: no limit).
PROJECTION_COPY_MARGIN_PCT: int = int(os.getenv("GRAPHVER_PROJECTION_COPY_MARGIN_PCT", "130"))
PROJECTION_COPY_MAX_BYTES: int = int(os.getenv("GRAPHVER_PROJECTION_COPY_MAX_BYTES", "0"))
# With no room for a build anywhere: ``wait`` (the serving key keeps serving its version) or
# ``in_place`` (the window is written into the serving key, paced). Alerted on past the second value.
PROJECTION_NO_ROOM_POLICY: str = os.getenv("GRAPHVER_PROJECTION_NO_ROOM_POLICY", "wait")
PROJECTION_NO_ROOM_ALERT_SECS: int = int(os.getenv("GRAPHVER_PROJECTION_NO_ROOM_ALERT_SECS", "1800"))
PROJECTION_CANDIDATE_CONCURRENCY: int = int(os.getenv("GRAPHVER_PROJECTION_CANDIDATE_CONCURRENCY", "2"))
PROJECTION_CANDIDATE_MAX_ATTEMPTS: int = int(os.getenv("GRAPHVER_PROJECTION_CANDIDATE_MAX_ATTEMPTS", "3"))
# The most rows a build still has to catch up when it switches, applied inside the switch.
PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS: int = int(os.getenv(
    "GRAPHVER_PROJECTION_CANDIDATE_FLIP_MAX_LAG_ROWS", str(PROJECTION_INLINE_MAX_ROWS)))
PROJECTION_CANDIDATE_WARM_SECS: int = int(os.getenv("GRAPHVER_PROJECTION_CANDIDATE_WARM_SECS", "30"))
# Pacing the projector's writes so reads of a graph being written keep their turn on its node: the
# time a write statement aims at, the most one may take, and the pause after each, as a share of
# its own time — and as a larger share while reads on the node are waiting.
PROJECTION_STATEMENT_TARGET_MS: int = int(os.getenv("GRAPHVER_PROJECTION_STATEMENT_TARGET_MS", "500"))
PROJECTION_WRITE_CEILING_S: int = int(os.getenv("GRAPHVER_PROJECTION_WRITE_CEILING_S", "10"))
PROJECTION_PACING_RATIO: float = float(os.getenv("GRAPHVER_PROJECTION_PACING_RATIO", "0.25"))
PROJECTION_READ_PRESSURE_RATIO: float = float(os.getenv("GRAPHVER_PROJECTION_READ_PRESSURE_RATIO",
                                                        "2.0"))
# Reads of main from Postgres, while FalkorDB holds no version of a graph: each statement's limit,
# and how many run at once per graph and per process, so a large graph's reads can't take the pool.
READ_STATEMENT_TIMEOUT_MS: int = int(os.getenv("GRAPHVER_READ_STATEMENT_TIMEOUT_MS", "15000"))
PG_READS_PER_GRAPH: int = int(os.getenv("GRAPHVER_PG_READS_PER_GRAPH", "4"))
PG_READS_PER_PROCESS: int = int(os.getenv("GRAPHVER_PG_READS_PER_PROCESS", "8"))
EVICT_SECS: int = int(os.getenv("GRAPHVER_EVICT_SECS", "300"))

# Residency (doc 17): each graph's class (Always / Standard / Coldline) and each cluster master's
# memory decide whether its key stays in FalkorDB, through the projection lane's capacity loop,
# once a system administrator turns on Graph residency (Admin → Features, ``residencyEnabled``;
# ``residency_policy.switch_state``). The worker no longer runs the count budget above, whatever
# the switch says. The residency policy's defaults follow; each is overridden live from the admin UI
# (platform_settings) and clamped to its range by ``residency_policy``.
EVICTION_ENABLED: bool = os.getenv("GRAPHVER_EVICTION_ENABLED", "1").lower() not in ("0", "false", "no")
STANDARD_IDLE_SECS: int = int(os.getenv("GRAPHVER_STANDARD_IDLE_SECS", "604800"))
COLDLINE_IDLE_SECS: int = int(os.getenv("GRAPHVER_COLDLINE_IDLE_SECS", "3600"))
MASTER_HIGH_WATER_PCT: int = int(os.getenv("GRAPHVER_MASTER_HIGH_WATER_PCT", "80"))
MASTER_LOW_WATER_PCT: int = int(os.getenv("GRAPHVER_MASTER_LOW_WATER_PCT", "70"))
LOAD_MARGIN_PCT: int = int(os.getenv("GRAPHVER_LOAD_MARGIN_PCT", "130"))
BYTES_PER_ENTITY: int = int(os.getenv("GRAPHVER_BYTES_PER_ENTITY", "550"))
COLDLINE_CANVAS_LOAD_ABOVE: int = int(os.getenv("GRAPHVER_COLDLINE_CANVAS_LOAD_ABOVE", "500000"))
CAPACITY_SECS: int = int(os.getenv("GRAPHVER_CAPACITY_SECS", "60"))

# DERIVED_LABELS / not_derived_clause are imported at the top of this module and
# re-exported here for this package's callers. The definition moved OUT to
# ``backend/common/derived_artifacts`` because the provider and profiling read
# paths need the same list and cannot import from the versioning package
# (deliberately decoupled) — so they went without one and re-broke this a second
# way. That module's docstring records both incidents.


def falkor_eviction_configured() -> bool:
    """True when any FalkorDB cache budget is set — gates the eviction daemon."""
    return FALKOR_MAX_RESIDENT > 0 or bool(FALKOR_BUDGETS)


def falkor_budget_for(provider: str) -> int:
    """Per-provider resident-graph budget: a per-provider override, else the
    default. 0 ⇒ unlimited for that provider."""
    return int(FALKOR_BUDGETS.get(provider, FALKOR_MAX_RESIDENT))

# Draft lifecycle (plan §17 #8): auto-abandon idle drafts after N days, swept by
# the worker every DRAFT_SWEEP_SECS (default hourly). The same pass deletes finished imports'
# staged rows (STAGING_GC_DAYS) and expired artifacts (OBJECT_STORE_TTL_HOURS): hourly, they go
# within the hour after they are due, not up to a day later.
DRAFT_TTL_DAYS: int = int(os.getenv("GRAPHVER_DRAFT_TTL_DAYS", "30"))
# A merged or abandoned draft keeps its changes this many days, then the same pass removes them in
# windows and keeps its record: the branch, its members, its commits and its review (a merged
# draft's changes are in main, in the commit it landed as). 0 keeps them for good. A system
# administrator overrides it live (Admin → Infrastructure → Versioned graphs → Draft retention;
# ``draft_retention``). Each pass spends at most DRAFT_PRUNE_PASS_SECS on it, so a draft of
# millions of rows is removed over a few passes rather than holding the worker or the
# database.
DRAFT_RETENTION_DAYS: int = int(os.getenv("GRAPHVER_DRAFT_RETENTION_DAYS", "30"))
DRAFT_PRUNE_PASS_SECS: float = 300.0

# Retries when a commit races another writer for the next per-branch commit_seq
# (uq_commits_branch_seq) — concurrent write-through writes to main.
COMMIT_MAX_RETRIES: int = int(os.getenv("GRAPHVER_COMMIT_MAX_RETRIES", "5"))
# How long a writer waits for a graph's lock (or a draft's row lock) before it gives up with
# 503 lock_busy and retries. Bounded, so a writer queued behind a long publish or sync cannot pin
# a pooled connection indefinitely; the 5 s matches the lease renewal's and the migrations' bound.
GRAPH_LOCK_TIMEOUT_MS: int = int(os.getenv("GRAPHVER_GRAPH_LOCK_TIMEOUT_MS", "5000"))
DRAFT_SWEEP_SECS: int = int(os.getenv("GRAPHVER_DRAFT_SWEEP_SECS", "3600"))

# A draft changing more entities than this has its Changes panel counted, not laid out as a
# containment tree: the tree is built from every changed payload and their ancestors, in the
# web process, per request.
DIFF_TREE_MAX_CHANGES: int = int(os.getenv("GRAPHVER_DIFF_TREE_MAX_CHANGES", "20000"))
# Change lists — a draft's changes, a revision's, two revisions compared (change_index.py) — are
# classified once from content hashes and version-row columns, no payload, and kept for their
# pages: about 300 bytes an entity. Past this many changed entities an origin is counted, not listed.
CHANGE_LIST_MAX: int = int(os.getenv("GRAPHVER_CHANGE_LIST_MAX", "250000"))
# Entries the change lists a web process keeps may hold together: the least recently read go
# first, the newest is kept whatever its size. About 90 MB at the default.
CHANGE_INDEX_CACHE_ENTRIES: int = int(os.getenv("GRAPHVER_CHANGE_INDEX_CACHE_ENTRIES", "300000"))
# Longest one statement building a change list or the history calendar may run before Postgres
# cancels it and the reader is told to try again. Each is an index range that finishes well inside
# a second at 100k changes; one that runs this long has a bad plan, and a web process should not
# hold its connection while it does.
CHANGE_INDEX_STATEMENT_TIMEOUT_MS: int = int(
    os.getenv("GRAPHVER_CHANGE_INDEX_STATEMENT_TIMEOUT_MS", "15000"))
# A draft changing more entities than this publishes (or has its review merged) as a job on the
# versioning worker, not inside the request: the squash holds every changed payload and hashes
# them all, which a web pod's memory and event loop can't spare at that size.
SYNC_PUBLISH_MAX_CHANGES: int = int(os.getenv("GRAPHVER_SYNC_PUBLISH_MAX_CHANGES", "20000"))
# Kill switch for the narrow squash: an up-to-date draft of a non-fork graph, published with no
# conflict resolutions, is planned from content hashes and its rows copied inside Postgres instead
# of every changed payload being loaded, merged and re-hashed in the worker. Off = always the full
# merge. Temporary: removed one release after the narrow squash ships.
NARROW_SQUASH: bool = os.getenv("GRAPHVER_NARROW_SQUASH", "1").lower() not in ("0", "false", "no")
# A narrow squash holds about 1.7 KB in the worker for each entity the draft changed (200k changes:
# ~340 MB). A draft that changed more than this many is squashed SQUASH_PAGE entities at a time
# instead, in the same one commit and transaction, so a publish of millions fits the worker.
SQUASH_PAGED_ABOVE: int = int(os.getenv("GRAPHVER_SQUASH_PAGED_ABOVE", "200000"))
SQUASH_PAGE: int = int(os.getenv("GRAPHVER_SQUASH_PAGE", "20000"))
# Live (not tombstoned) forks one graph may have; one more is refused with 409 fork_limit. A fork
# has no FalkorDB key of its own (it reads through its root's), so this bounds the readers' patch
# sets and the forks' rows, until capacity management (E7) brings a real quota.
MAX_FORKS_PER_GRAPH: int = int(os.getenv("GRAPHVER_MAX_FORKS_PER_GRAPH", "10"))
# A fork's main reads its root's store with its patch set laid over it, which classifies every
# entity either side changed since they parted. Past this many, its reads go to Postgres instead
# (layered reads) and the fork recommends an update from its parent; at the warning, the
# parent's changes it has not taken in recommend one too.
FORK_REWIND_MAX: int = int(os.getenv("GRAPHVER_FORK_REWIND_MAX", "200000"))
# The canvas reads main as it was at a past revision as main's store with a patch set over it: every
# entity main changed since then, at about 1.2 KB an entry in the overlay cache below. A revision more
# than this many entities behind main's head is too far back to draw (409 revision_too_far); its
# change list, a comparison and an export still reach it.
REVISION_REWIND_MAX: int = int(os.getenv("GRAPHVER_REVISION_REWIND_MAX", "100000"))
FORK_REWIND_WARN: int = int(os.getenv("GRAPHVER_FORK_REWIND_WARN", "50000"))
# Drop the FalkorDB copies earlier releases made of forks (Reaper.fork_copies). Off by default:
# pods still running such a release read and project them. Turn it on once every pod runs this one.
DROP_FORK_COPIES: bool = os.getenv("GRAPHVER_DROP_FORK_COPIES", "false").lower() in ("1", "true", "yes")
# Entries the overlay deltas a process keeps for drafts' and forks' reads may hold together; the
# least recently read go first, the newest is kept whatever its size. Sized at about 1.2 KB an
# entry (measured: 0.74 KB a draft's, 0.87 KB a fork's, before allocator slack and the chains a
# rollup read keeps), so a web process holds under 512 MB of them. An evicted delta is built again
# on its next read: 2 to 6 s for 50,000 to 145,000 entries.
OVERLAY_CACHE_ENTRIES: int = int(os.getenv("GRAPHVER_OVERLAY_CACHE_ENTRIES", "400000"))

# Default per-data-source audit tier (plan decision #8): commit_only | full_wip.
DEFAULT_AUDIT_TIER: str = os.getenv("GRAPHVER_DEFAULT_AUDIT_TIER", "commit_only")

# Default ontology enforcement for new graphs: strict | permissive.
DEFAULT_ONTOLOGY_ENFORCEMENT: str = os.getenv("GRAPHVER_ONTOLOGY_ENFORCEMENT", "strict")

# Payload fields merged as unordered sets in 3-way merge (e.g. tags). Comma-
# separated; the ontology can extend this per-graph later.
SET_FIELDS = frozenset(
    f.strip() for f in os.getenv("GRAPHVER_SET_FIELDS", "tags").split(",") if f.strip()
)

# Ephemeral analysis/time-travel projection pool (plan decision #3).
EPHEMERAL_POOL_MAX_GRAPHS: int = int(os.getenv("GRAPHVER_EPHEMERAL_MAX_GRAPHS", "32"))
EPHEMERAL_TTL_SECS: int = int(os.getenv("GRAPHVER_EPHEMERAL_TTL_SECS", "900"))

# Read-trace lease TTL guarding a FalkorDB graph against mid-read eviction
# (plan §16.5 #9).
TRACE_LEASE_TTL_SECS: int = int(os.getenv("GRAPHVER_TRACE_LEASE_TTL_SECS", "120"))


# --------------------------------------------------------------------------- #
# Import / Export (bulk CRUD) — object store + pipeline tunables               #
# --------------------------------------------------------------------------- #
def object_store_backend() -> str:
    """Which ObjectStore backend serves import/export artifacts: database | local | s3 | gcs.

    The management database by default, which every API pod shares: an artifact one pod stored
    is there whichever pod serves the next request. ``local`` keeps them as files under
    ``IMPORT_STORE_ROOT``: a directory every API and versioning-worker pod mounts (a shared volume,
    or an S3/GCS bucket through its FUSE driver), or one pod's own disk for a single-pod stack.
    S3/GCS are drop-in behind the same Protocol."""
    return os.getenv("OBJECT_STORE_BACKEND", "database").lower()


def import_store_root() -> str:
    """Filesystem root for the LocalFs object store (``OBJECT_STORE_BACKEND=local``): where the
    files land, typically a mount every pod shares.

    Artifacts live under ``{root}/{workspace}/{data_source}/{graph}/{job}/{name}`` so any file
    is attributable to its workspace/data source/graph/job at a glance."""
    return os.getenv("IMPORT_STORE_ROOT", "/tmp/synodic-import-store")


def object_store_s3() -> dict:
    """The S3-compatible object store (``OBJECT_STORE_BACKEND=s3``; optional, it needs
    ``requirements-s3.txt``): Amazon S3, MinIO, or GCS through its XML API. Credentials come from
    boto3's own chain: ``AWS_ACCESS_KEY_ID``/``AWS_SECRET_ACCESS_KEY`` (for GCS, an HMAC key), or a
    role.

    ``PREFIX`` is what every key goes under: the daily sweep deletes whatever under it is old, so by
    default it never reaches anything else the bucket holds. ``ENDPOINT_URL`` for anything but Amazon
    S3 (``https://storage.googleapis.com`` for GCS); ``ADDRESSING`` ``auto`` | ``path`` (MinIO) |
    ``virtual``. ``PRESIGN=1`` hands browsers presigned URLs, so package parts go up to the bucket
    and exports come down from it without passing through the API: the endpoint must be one browsers
    reach, and the bucket's CORS must allow this site's PUTs."""
    return {
        "bucket": os.getenv("OBJECT_STORE_S3_BUCKET", ""),
        # Never the bucket's root, even when set empty: the sweep would delete everything old in it.
        "prefix": os.getenv("OBJECT_STORE_S3_PREFIX", "").strip("/") or "synodic-import-store",
        "endpoint_url": os.getenv("OBJECT_STORE_S3_ENDPOINT_URL") or None,
        "region": os.getenv("OBJECT_STORE_S3_REGION") or None,
        "addressing": os.getenv("OBJECT_STORE_S3_ADDRESSING", "auto").lower(),
        "presign": os.getenv("OBJECT_STORE_S3_PRESIGN", "").lower() in ("1", "true", "yes"),
    }


# Staged rows per import window: one commit onto the draft, together with the job's checkpoint. A
# window is also what a resumed import redoes at most, and what the job's lease waits out before a
# stopping worker hands the job back — so a few seconds of work, not minutes.
IMPORT_COMMIT_WINDOW: int = int(os.getenv("IMPORT_COMMIT_WINDOW", "10000"))
# What an import's rows find their entities by when neither the request nor its data source names
# one (``identifier``): ``entity_id`` (an entity id of the graph, else the urn, the identifier
# property, a field a type matches imports by, then a unique qualifiedName), ``urn`` (an entity id,
# else the urn only), ``prop.<name>`` (an entity id, else the value of the property <name>), or
# ``prop.<name>,urn`` (the property, then the urn; a node found by its urn takes the value).
IMPORT_IDENTIFIER: str = os.getenv("GRAPHVER_IMPORT_IDENTIFIER", "entity_id")
# A replace deletes whatever its file leaves out of its scope. One that would delete most of a scope
# AND make most of it again is what a file whose rows name their entities by another key looks like:
# its rows match nothing, so the run deletes the scope and makes it anew, every id and its history
# with it. In a scope of at least IMPORT_REPLACE_GUARD_MIN_LIVE entities, a replace that would delete
# at least IMPORT_REPLACE_GUARD_DELETE_FRACTION of them and create at least
# IMPORT_REPLACE_GUARD_CREATE_FRACTION as many (rows it refused that matched nothing count with what
# it creates) is refused before it deletes anything, unless it is sent with allowMassDelete=true.
# Fractions of the scope's entities, nodes and edges (0.5 = half).
IMPORT_REPLACE_GUARD: bool = os.getenv("IMPORT_REPLACE_GUARD", "1").lower() not in ("0", "false", "no")
IMPORT_REPLACE_GUARD_MIN_LIVE: int = int(os.getenv("IMPORT_REPLACE_GUARD_MIN_LIVE", "1000"))
IMPORT_REPLACE_GUARD_DELETE_FRACTION: float = float(
    os.getenv("IMPORT_REPLACE_GUARD_DELETE_FRACTION", "0.5"))
IMPORT_REPLACE_GUARD_CREATE_FRACTION: float = float(
    os.getenv("IMPORT_REPLACE_GUARD_CREATE_FRACTION", "0.5"))
# And earlier: a replace whose first node window (IMPORT_COMMIT_WINDOW rows, or all of a smaller
# file's node rows) finds an entity for fewer than this fraction of its rows, in a graph of at least
# IMPORT_REPLACE_GUARD_MIN_LIVE entities, stops there, naming its identifier, rather than read the
# rest of the file first, unless it is sent with allowMassDelete=true. 0 turns it off.
IMPORT_REPLACE_MIN_MATCH_FRACTION: float = float(os.getenv("IMPORT_REPLACE_MIN_MATCH_FRACTION", "0.05"))
# How many of an import's file's rows may be refused before it holds, when the import doesn't say
# (maxRefusedRows): past it, a replace deletes nothing and fails (rows_refused), and an import that
# would publish itself (autoPublish) leaves its draft for review instead. "0" holds on any refused
# row; a count ("100") or a share of the file's rows ("0.5%") goes on within it; "-1" always goes
# on. Going on, a replace keeps what a refused row still names (a refused delete row, only what it
# matched). Every import reports its refused rows, with why (summary.refused).
IMPORT_MAX_REFUSED_ROWS: str = os.getenv("IMPORT_MAX_REFUSED_ROWS", "0")
# Properties a graph's imports may match nodes by (identifier=prop.<name>), at most: each has an index
# kept current from the version log, as Dataverse limits alternate keys and Salesforce external ids.
MAX_MATCHING_PROPERTIES: int = int(os.getenv("GRAPHVER_MAX_MATCHING_PROPERTIES", "10"))
# Rows returned inline in a preview before the full diff must be downloaded.
PREVIEW_SAMPLE_LIMIT: int = int(os.getenv("IMPORT_PREVIEW_SAMPLE_LIMIT", "200"))
# Two-tier threshold: imports at/below this stage client-side (existing Review & Save); above
# it run the async worker.
INLINE_IMPORT_MAX: int = int(os.getenv("INLINE_IMPORT_MAX", "5000"))
# Hard ceiling on rows in one import (guardrail); 0 = unlimited.
IMPORT_MAX_ROWS: int = int(os.getenv("IMPORT_MAX_ROWS", "0"))
# Days a finished import's staged rows (``import_rows``: 3.4-7x its file) are kept after the
# job ends, and a failed import's file with them, to resume it or queue it again. Its row preview
# goes with them; the draft's changes stay. 1 keeps them a day.
STAGING_GC_DAYS: int = int(os.getenv("IMPORT_STAGING_GC_DAYS", "3"))
# The worker's hourly sweep deletes object-store artifacts (uploads, exports, view packages)
# written more than this many hours ago.
OBJECT_STORE_TTL_HOURS: float = float(os.getenv("OBJECT_STORE_TTL_HOURS", "24"))
# Import, export and publish jobs run ONLY on the versioning worker's transfer lane: the API queues
# them. Running them in the web process (the old default) shared its CPU, memory and event loop
# with interactive requests, and a restart or gunicorn's 120 s worker timeout lost the job.
if os.getenv("GRAPHVER_TRANSFER_INPROCESS"):
    logging.getLogger(__name__).warning(
        "GRAPHVER_TRANSFER_INPROCESS is set but no longer read: import, export and publish jobs "
        "always run on the versioning worker's transfer lane (GRAPHVER_WORKER_LANES). Remove it.")
# Jobs one versioning-worker process runs at once. An export job also takes one of its pod's export
# turns (GRAPH_EXPORT_CONCURRENCY, 2), so raise the two together.
TRANSFER_SLOTS: int = int(os.getenv("GRAPHVER_TRANSFER_SLOTS", "2"))
# How often an idle worker looks for a queued job: about how long a queued job waits for a free one.
TRANSFER_POLL_SECS: float = float(os.getenv("GRAPHVER_TRANSFER_POLL_SECS", "1"))
# A queued job no worker has started in this long reads as failed, when no job of the lane was
# claimed or beat in that time either: none is running. Behind busy workers it waits its turn.
TRANSFER_QUEUE_TIMEOUT_SECS: int = int(os.getenv("GRAPHVER_TRANSFER_QUEUE_TIMEOUT_SECS", str(6 * 3600)))
# The transfer lane's JobReaper rules (import_export/runner.py), here so the schema upgrade that
# fails such jobs before building uq_jobs_ingest_active (models.py) applies the same ones.
# What a queued job reads when no worker took it in TRANSFER_QUEUE_TIMEOUT_SECS.
JOB_NOT_STARTED = ("No worker started the job in time. Start it again, or ask an administrator whether "
                   "the versioning worker is running.")
# What a job reads whose creator never stored its input and queued it (an upload cut off midway).
JOB_NEVER_QUEUED = "The upload never finished, so the job never started. Start it again."
# How long a job may sit created but never queued before that is what happened to it.
JOB_NEVER_QUEUED_SECS = 3600


# --------------------------------------------------------------------------- #
# "Enable version control" bootstrap job (async, resumable, integrity-checked)  #
# --------------------------------------------------------------------------- #
# The source graph is scanned in ID-RANGE windows (never OFFSET: deep offsets are
# O(n²) at 10M) and written in per-window transactions, so peak memory is O(window)
# regardless of graph size. The cursor (next `lo`) is checkpointed on the job row,
# making a crashed job resumable mid-phase.
BOOTSTRAP_SCAN_WIDTH: int = int(os.getenv("GRAPHVER_BOOTSTRAP_SCAN_WIDTH", "100000"))
BOOTSTRAP_SCAN_MIN_WIDTH: int = int(os.getenv("GRAPHVER_BOOTSTRAP_SCAN_MIN_WIDTH", "10000"))
# Edges per window. A node-id window is a terrible predictor of how many EDGES it holds:
# ids cluster by entity type, so on a real 5M-edge model one 10k-node window held 15k edges
# and the next held 185k — enough to blow the server's per-query budget even at the minimum
# node width. Counting a window's edges first is cheap (~0.1s); returning them is not. So the
# edge phase sizes its window by this target and halves the node span until it fits.
BOOTSTRAP_EDGE_TARGET: int = int(os.getenv("GRAPHVER_BOOTSTRAP_EDGE_TARGET", "50000"))
# Rows accumulated before a window is committed to Postgres.
BOOTSTRAP_WINDOW: int = int(os.getenv("GRAPHVER_BOOTSTRAP_WINDOW", "50000"))
# Entities re-read from the SOURCE and content-hash-compared during validation.
BOOTSTRAP_SAMPLE_K: int = int(os.getenv("GRAPHVER_BOOTSTRAP_SAMPLE_K", "64"))
# The backfill WRITES to the customer's live graph (anchor keys, and re-pointing a duplicate
# collapse's edges), and a FalkorDB write holds the graph's write lock for its whole run, queueing
# every canvas read behind it. So each write is fitted to at most this many changes, and the job
# pauses this long between writes to let the readers through.
BOOTSTRAP_BACKFILL_MAX_WRITES: int = int(os.getenv("GRAPHVER_BOOTSTRAP_BACKFILL_MAX_WRITES", "20000"))
BOOTSTRAP_BACKFILL_PAUSE_MS: int = int(os.getenv("GRAPHVER_BOOTSTRAP_BACKFILL_PAUSE_MS", "200"))
# The import commit's Merkle tree is built inline up to this many entities; above it
# the root is left NULL (the column is expressly "async-filled for bulk") and the
# report says so, rather than OOM-ing on a 10M-entity in-memory tree.
BOOTSTRAP_MERKLE_INLINE_MAX: int = int(os.getenv("GRAPHVER_BOOTSTRAP_MERKLE_MAX", "1000000"))
# A new data source seeded from a view package (``package_seed``): data lines parsed, converted and
# written per window — one worker-thread hop and one fenced transaction each — and version rows
# projected into the new FalkorDB key per window. Peak memory is O(window), whatever the package.
PACKAGE_SEED_WINDOW: int = int(os.getenv("GRAPHVER_PACKAGE_SEED_WINDOW", "20000"))
PACKAGE_PROJECT_WINDOW: int = int(os.getenv("GRAPHVER_PACKAGE_PROJECT_WINDOW", "20000"))
# Worker pickup cadence + the heartbeat age after which a `running` job is presumed
# dead and taken over by another worker (JobORM is the durable queue; no stream).
INGEST_POLL_SECS: int = int(os.getenv("GRAPHVER_INGEST_POLL_SECS", "5"))
INGEST_STALE_SECS: int = int(os.getenv("GRAPHVER_INGEST_STALE_SECS", "120"))
# How often a running worker says "still alive". This must be comfortably shorter than
# INGEST_STALE_SECS, and it must be a TIMER rather than a per-window commit: a scan halving
# its way down the ladder, or a validate anti-joining a 10M-row commit, can work for minutes
# without committing anything. Heartbeating only on commit would let a second worker declare
# a healthy worker dead and steal its job — and the two would then trade it back and forth
# indefinitely. Default = a quarter of the stale window, i.e. three missed beats before a
# worker is presumed dead.
INGEST_HEARTBEAT_SECS: int = int(os.getenv(
    "GRAPHVER_INGEST_HEARTBEAT_SECS", str(max(5, INGEST_STALE_SECS // 4))))
# A copy of a 10M-entity graph runs for tens of minutes, which is long enough to SPAN
# ordinary infrastructure events: a FalkorDB restart or RDB reload, a Postgres failover,
# a Kubernetes node rotation, a transient network partition. Those must not destroy a
# job that is 80% done — the worker waits them out. Each window gets its own budget of
# retrying (a successful window resets it), so this is "how long an outage may last",
# not "how long the job may take". Beyond it the job fails honestly and stays resumable.
# The largest graph a RE-SYNC is allowed to attempt, in entities (nodes + edges).
#
# This is a guard rail over a real limitation, not a policy: `sync_ingest` rebuilds the whole
# graph several times over to do its 3-way merge, and measured cost is ~4.5 KiB of RSS per
# entity — 2.03 GB to compute 808 changes on a 478k graph, in one HTTP request on the web tier.
# Linearly, the 7.7M model asks for ~30 GB and takes the API process down with it. Above the
# limit the operation does not work, so refusing with an honest number is strictly better than
# an OOM — an OOM kills every other request in flight as well, and explains nothing.
#
# 250k ≈ a 1.1 GB peak: survivable on a web process, and comfortably above every real graph
# we have seen (the largest non-synthetic one is ~200k). Raise it only if you know the memory
# is there. It exists to be DELETED: see docs/versioning/11-resync-at-any-scale.md, which
# makes re-sync bounded and moves it onto the worker, after which no limit is needed.
RESYNC_MAX_ENTITIES: int = int(os.getenv("GRAPHVER_RESYNC_MAX_ENTITIES", "250000"))

# A sync deletes by ABSENCE, so a snapshot that is missing rows (a truncated provider page,
# BOOTSTRAP-3) reads as the source deleting them. A sync that would delete more than
# max(SYNC_DELETE_MAX_ABS, SYNC_DELETE_MAX_FRACTION x live entities on main) is refused unless
# a workspace admin passes allowMassDelete. The fraction is a FRACTION (0.05 = 5%), not a
# percent. Stop-gap: INGEST S1's per-source delete breaker replaces it.
SYNC_DELETE_MAX_ABS: int = int(os.getenv("GRAPHVER_SYNC_DELETE_MAX_ABS", "500"))
SYNC_DELETE_MAX_FRACTION: float = float(os.getenv("GRAPHVER_SYNC_DELETE_MAX_FRACTION", "0.05"))

BOOTSTRAP_RETRY_BUDGET_SECS: int = int(os.getenv("GRAPHVER_BOOTSTRAP_RETRY_BUDGET_SECS", "600"))
BOOTSTRAP_RETRY_MAX_DELAY_SECS: float = float(
    os.getenv("GRAPHVER_BOOTSTRAP_RETRY_MAX_DELAY_SECS", "30"))

# Rows deleted per transaction when purging a deleted graph. One graph here is ~2.9M rows and a
# real one is 7.7M+, so this is the knob that keeps a purge from becoming one enormous
# transaction holding locks and generating WAL for the entire graph. 25k keeps each window well
# under a second on the live table while making the whole purge ~120 transactions per million
# rows. It does NOT need to be large: the windows are Index Scans (see purge_worker), so there is
# no per-window rescan cost to amortise away.
PURGE_WINDOW: int = int(os.getenv("GRAPHVER_PURGE_WINDOW", "25000"))

# THE UNDO WINDOW. A deleted data source sits in the trash for this long, fully restorable, and is
# only then reclaimed. The tombstone's age IS the schedule — there is no scheduler table and no
# `scheduled_for` column; the reaper simply asks which tombstones are older than this.
PURGE_GRACE_DAYS: int = int(os.getenv("GRAPHVER_PURGE_GRACE_DAYS", "30"))

# How often the reaper looks. Nothing is time-critical here — a tombstone that expires at 09:00
# and gets reaped at 09:15 has cost nobody anything — and a slow scan keeps the trash query off
# the hot path. It is deliberately NOT the 5s job poll.
REAP_POLL_SECS: int = int(os.getenv("GRAPHVER_REAP_POLL_SECS", "900"))


# --------------------------------------------------------------------------- #
# Worker lanes and the job lease (job_lease.py)                                #
# --------------------------------------------------------------------------- #
# A versioning-worker process runs one or more LANES, so production can scale and isolate them as
# separate pods while compose and dev run all three in one process:
#   projection  the FalkorDB projection (poll, stream, idle-draft sweep, cache eviction);
#   transfer    import / export / publish jobs, plus one dedicated package_inspect slot;
#   bootstrap   "enable version control" and package seeds, purges, and the undo-window reaper.
LANES = ("projection", "transfer", "bootstrap")


def worker_lanes() -> frozenset:
    """The lanes this process runs (``GRAPHVER_WORKER_LANES``, comma-separated; all by default).

    An unknown name fails start-up rather than being skipped: a pod whose lane is misspelt would
    otherwise run nothing, healthily, while its jobs queue forever."""
    raw = os.getenv("GRAPHVER_WORKER_LANES", ",".join(LANES))
    lanes = frozenset(p.strip().lower() for p in raw.split(",") if p.strip())
    unknown = lanes - set(LANES)
    if unknown or not lanes:
        raise ValueError(f"GRAPHVER_WORKER_LANES={raw!r}: expected a comma-separated subset of "
                         f"{', '.join(LANES)}")
    return lanes


# Bootstrap and package-seed jobs one process runs at once, and at most this many at once per
# (FalkorDB provider, origin) across ALL workers: a bootstrap scans the customer's FalkorDB, and
# several scans of one instance at once slow every reader of it.
BOOTSTRAP_SLOTS: int = int(os.getenv("GRAPHVER_BOOTSTRAP_SLOTS", "2"))
BOOTSTRAP_PER_PROVIDER: int = int(os.getenv("GRAPHVER_BOOTSTRAP_PER_PROVIDER", "2"))
# A SOFT per-workspace share of a lane's running jobs: a claim prefers the job of a workspace
# running fewer than this, so one tenant queueing 50 imports doesn't hold every slot while
# another's single job waits. Soft (work-conserving): with nobody else waiting it still runs.
JOBS_PER_WORKSPACE: int = int(os.getenv("GRAPHVER_JOBS_PER_WORKSPACE", "2"))
# The same SOFT share per person, after the workspace's: a claim prefers the job of someone running
# fewer than this, so one person queueing ten large imports doesn't hold their workspace's share
# while a colleague's export waits. A job is the person's who asked for it (an export, a publish);
# an import is its draft owner's. Soft too: with nobody else waiting, their jobs still run.
JOBS_PER_USER: int = int(os.getenv("GRAPHVER_JOBS_PER_USER", "1"))
# How long a stopping worker gives its running jobs to hand themselves back at a window boundary
# (release: pending again, cursor kept) before cancelling them. Inside the deployment's 60 s
# termination grace, with time left to release the cancelled ones.
DRAIN_SECS: float = float(os.getenv("GRAPHVER_DRAIN_SECS", "40"))
# A standalone worker whose event loop has not ticked for this long is WEDGED (a synchronous call
# that never returns): its jobs would never finish while the heartbeat thread kept them leased,
# so it dumps every thread's stack and exits for the orchestrator to restart it.
JOB_WEDGE_SECS: float = float(os.getenv("GRAPHVER_JOB_WEDGE_SECS", "900"))


def lane_pool_size(lanes) -> int:
    """graphver connections a worker running ``lanes`` needs, when ``GRAPHVER_POOL_SIZE`` is unset.

    Sized from what each lane holds at once — projection: one per concurrent graph plus the poll,
    stream and sweep; transfer: two per slot (the job's window and a nested read) plus the inspect
    slot; bootstrap: three per slot (window, phase driver, a validation read) plus purge and reaper —
    so a busy lane waits on its own work, never on a pool sized for a web process."""
    size = 2
    if "projection" in lanes:
        size += PROJECTION_CONCURRENCY + 3
    if "transfer" in lanes:
        size += 2 * (TRANSFER_SLOTS + 1)
    if "bootstrap" in lanes:
        size += 3 * BOOTSTRAP_SLOTS + 2
    return size


def _selftest() -> None:
    assert PARTITIONS >= 1 and MERKLE_DEPTH >= 1
    h1 = hash_parts(b"ab", b"c")
    h2 = hash_parts(b"a", b"bc")
    assert h1 != h2, "length-prefixing must disambiguate concatenation"
    assert len(empty_hash()) == len(h1)
    assert graphver_db_url().startswith("postgresql+asyncpg://")
    print("config.py self-test: OK")


if __name__ == "__main__":
    _selftest()
