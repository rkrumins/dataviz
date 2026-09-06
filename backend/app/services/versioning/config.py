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

# Bulk ingest / projection batch sizes (rows per COPY / UNWIND chunk).
INGEST_BATCH_SIZE: int = int(os.getenv("GRAPHVER_INGEST_BATCH_SIZE", "5000"))
PROJECTION_BATCH_SIZE: int = int(os.getenv("GRAPHVER_PROJECTION_BATCH_SIZE", "5000"))

# Projection worker: poll cadence for the reconciling loop, read freshness
# tolerance (a read serves from FalkorDB while projected >= committed - lag),
# the worker's health port, and whether the web process also runs the poll loop.
PROJECTION_POLL_SECS: int = int(os.getenv("GRAPHVER_PROJECTION_POLL_SECS", "5"))
# Max graphs projected concurrently per reconciling poll pass (each id appears once per pass,
# so there's no same-graph race) — keeps the worker caught up across 100s of graphs.
PROJECTION_CONCURRENCY: int = int(os.getenv("GRAPHVER_PROJECTION_CONCURRENCY", "8"))
READ_MAX_LAG: int = int(os.getenv("GRAPHVER_READ_MAX_LAG", "0"))
# After each projection, cheaply reconcile live node/edge COUNTS between Postgres
# (the SoR) and FalkorDB (the cache); on a mismatch, bounded-heal by reseeding the
# graph from Postgres once. Guards against a silently dropped delete leaving the
# cache diverged from committed main. Disable with GRAPHVER_PROJECTION_VERIFY=0.
PROJECTION_VERIFY_ENABLED: bool = os.getenv("GRAPHVER_PROJECTION_VERIFY", "1").lower() not in ("0", "false", "no")
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
WORKER_HEALTH_PORT: int = int(os.getenv("GRAPHVER_WORKER_HEALTH_PORT", "8092"))
PROJECTION_INPROCESS: bool = os.getenv("GRAPHVER_PROJECTION_INPROCESS", "").lower() in ("1", "true", "yes")
# Ceiling for an EXPLICIT operator rebuild run in-process (Data health → "Rebuild"):
# a full reseed is O(whole main graph), so it gets a generous budget — unlike the
# interactive 10s post-write catch-up, which stays snappy and defers to the worker.
REBUILD_SYNC_TIMEOUT_SECS: int = int(os.getenv("GRAPHVER_REBUILD_TIMEOUT_SECS", "900"))

# Provider write-through: record every graph write as an audited versioned commit on the
# data source's versioned graph (the audit trail + branch/version history, on by default).
# Set GRAPHVER_VERSIONED_WRITES=0 to opt out (writes then hit the provider only).
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
EVICT_SECS: int = int(os.getenv("GRAPHVER_EVICT_SECS", "300"))

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
# the worker every DRAFT_SWEEP_SECS (default daily).
DRAFT_TTL_DAYS: int = int(os.getenv("GRAPHVER_DRAFT_TTL_DAYS", "30"))

# Retries when a commit races another writer for the next per-branch commit_seq
# (uq_commits_branch_seq) — concurrent write-through writes to main.
COMMIT_MAX_RETRIES: int = int(os.getenv("GRAPHVER_COMMIT_MAX_RETRIES", "5"))
DRAFT_SWEEP_SECS: int = int(os.getenv("GRAPHVER_DRAFT_SWEEP_SECS", "86400"))

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
    """Which ObjectStore backend serves import/export artifacts: local | s3 | gcs.

    LocalFS in v1 (a mounted volume); S3/GCS are drop-in behind the same Protocol."""
    return os.getenv("OBJECT_STORE_BACKEND", "local").lower()


def import_store_root() -> str:
    """Filesystem root for the LocalFs object store (a mounted volume in prod).

    Artifacts live under ``{root}/{workspace}/{data_source}/{graph}/{job}/{name}`` so any file
    is attributable to its workspace/data source/graph/job at a glance."""
    return os.getenv("IMPORT_STORE_ROOT", "/tmp/synodic-import-store")


# Accepted deltas per windowed ``checkpoint`` commit the import worker writes onto the draft.
IMPORT_COMMIT_WINDOW: int = int(os.getenv("IMPORT_COMMIT_WINDOW", "50000"))
# Rows returned inline in a preview before the full diff must be downloaded.
PREVIEW_SAMPLE_LIMIT: int = int(os.getenv("IMPORT_PREVIEW_SAMPLE_LIMIT", "200"))
# Two-tier threshold: imports at/below this stage client-side (existing Review & Save); above
# it run the async worker.
INLINE_IMPORT_MAX: int = int(os.getenv("INLINE_IMPORT_MAX", "5000"))
# Hard ceiling on rows in one import (guardrail); 0 = unlimited.
IMPORT_MAX_ROWS: int = int(os.getenv("IMPORT_MAX_ROWS", "0"))
# Retain import/export artifacts + staging rows this many days after a terminal job.
STAGING_GC_DAYS: int = int(os.getenv("IMPORT_STAGING_GC_DAYS", "7"))


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
# The import commit's Merkle tree is built inline up to this many entities; above it
# the root is left NULL (the column is expressly "async-filled for bulk") and the
# report says so, rather than OOM-ing on a 10M-entity in-memory tree.
BOOTSTRAP_MERKLE_INLINE_MAX: int = int(os.getenv("GRAPHVER_BOOTSTRAP_MERKLE_MAX", "1000000"))
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
