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
READ_MAX_LAG: int = int(os.getenv("GRAPHVER_READ_MAX_LAG", "0"))
WORKER_HEALTH_PORT: int = int(os.getenv("GRAPHVER_WORKER_HEALTH_PORT", "8092"))
PROJECTION_INPROCESS: bool = os.getenv("GRAPHVER_PROJECTION_INPROCESS", "").lower() in ("1", "true", "yes")

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
