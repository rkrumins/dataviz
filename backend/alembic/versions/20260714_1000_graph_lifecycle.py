"""Graph lifecycle: soft-delete, FalkorDB ownership, and the purge job type.

Three columns and one widened CHECK, and every one of them exists to stop us destroying
something we do not own.

1. ``graphs.deleted_at`` / ``deleted_by`` — SOFT DELETE, as a PURGE TOMBSTONE. Reclaiming 2.9M
   rows (a real graph here) takes ~35s on the versioning worker, and 7.7M takes minutes; that is
   not something an HTTP request does inline. The tombstone lets the graph vanish from every read
   the instant the user asks, while the purge grinds through the rows behind it — so nothing ever
   resolves a graph that is half deleted.

   It is NOT an undo window, and the UI does not offer one. A real undo would need the DATA SOURCE
   row soft-deleted too, and it is hard-deleted; promising a restore we cannot perform would be
   worse than promising nothing. The dialog says "this cannot be undone", and means it.

2. ``projection_state.owns_falkor_graph`` — THE GUARDRAIL. A bootstrapped graph is PINNED to the
   customer's REAL FalkorDB graph (`nexus_lineage`, `perf-load-test-solidatus`) — that pinning is
   what makes the projection a fast-forward instead of a reseed. So "delete the versioned graph"
   must NEVER mean "delete that FalkorDB graph": it is not ours, it predates us, and it may be
   shared. Until now the only thing separating a purge from destroying production data was a
   NAME-PATTERN HEURISTIC in a cleanup script (`gv_*`, `gvt_*`, `blank_*`). Anyone who names a
   graph `gv_finance` loses it.

   Ownership is now recorded explicitly, at creation, from a fact we actually know: we own the
   graph IFF WE GENERATED ITS NAME. If a caller pointed us at an existing graph, it is theirs.

   **DEFAULT FALSE.** Fail-safe, deliberately. An unknown graph is never deleted. The cost of
   guessing wrong is not symmetric: refusing to delete leaks a graph; deleting wrongly destroys a
   customer's data.

3. ``jobs.job_type = 'purge'`` — reclaiming millions of partitioned rows is windowed, resumable
   and fenced, exactly like the bootstrap. It is not something an HTTP request can do.

   WIDEN-ONLY (`required ∪ present`): `graphver.jobs` is a shared, multi-producer table and a
   CHECK rebuilt from a hard-coded allow-list has wedged alembic on it before.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from backend.app.services.versioning import config as gv_config

revision: str = "20260714_1000_graph_lifecycle"
down_revision: Union[str, None] = "20260713_1400_jobs_bootstrap"
branch_labels = None
depends_on = None

_REQUIRED: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap", "purge")
_REQUIRED_BEFORE: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap")


def _widen_job_type_check(bind, required: Sequence[str]) -> None:
    jobs = f'"{gv_config.graphver_schema()}"."jobs"'
    present = {
        r[0] for r in bind.execute(sa.text(f"SELECT DISTINCT job_type FROM {jobs}")) if r[0]
    }
    values = ", ".join("'" + t.replace("'", "''") + "'" for t in sorted(set(required) | present))
    bind.execute(sa.text(f"ALTER TABLE {jobs} DROP CONSTRAINT IF EXISTS ck_jobs_type"))
    bind.execute(sa.text(
        f"ALTER TABLE {jobs} ADD CONSTRAINT ck_jobs_type CHECK (job_type IN ({values}))"))


def upgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    graphs = f'"{sch}"."graphs"'
    ps = f'"{sch}"."projection_state"'

    bind.execute(sa.text(f"ALTER TABLE {graphs} ADD COLUMN IF NOT EXISTS deleted_at TEXT"))
    bind.execute(sa.text(f"ALTER TABLE {graphs} ADD COLUMN IF NOT EXISTS deleted_by TEXT"))
    # Every read filters on this; a graph in the trash must disappear instantly and cheaply.
    bind.execute(sa.text(
        f'CREATE INDEX IF NOT EXISTS ix_graphs_live ON {graphs} (data_source_id) '
        "WHERE deleted_at IS NULL"))

    bind.execute(sa.text(
        f"ALTER TABLE {ps} ADD COLUMN IF NOT EXISTS owns_falkor_graph BOOLEAN NOT NULL "
        "DEFAULT false"))

    # ── One-time backfill, and the ONLY place a name heuristic is ever allowed to run ──
    #
    # Existing rows predate the flag, so ownership has to be inferred once. This is defensible
    # precisely because it is a single, explicit, reviewable migration rather than a rule the
    # runtime keeps applying: `gv_<id>` / `gv_*__fork_*` / `gvt_*` / `blank_*` are names only the
    # versioning layer generates. EVERYTHING ELSE STAYS FALSE — a graph we cannot prove we created
    # is a graph we will not delete.
    bind.execute(sa.text(
        f"UPDATE {ps} SET owns_falkor_graph = true "
        "WHERE falkor_graph_name IS NOT NULL AND ("
        "     falkor_graph_name LIKE 'gv\\_%' "
        "  OR falkor_graph_name LIKE 'gvt%' "
        "  OR falkor_graph_name LIKE 'blank\\_%')"))

    _widen_job_type_check(bind, _REQUIRED)


def downgrade() -> None:
    bind = op.get_bind()
    sch = gv_config.graphver_schema()
    graphs = f'"{sch}"."graphs"'
    ps = f'"{sch}"."projection_state"'
    # Widen-only in reverse too: never delete rows to satisfy a CHECK.
    _widen_job_type_check(bind, _REQUIRED_BEFORE)
    bind.execute(sa.text(f"ALTER TABLE {ps} DROP COLUMN IF EXISTS owns_falkor_graph"))
    bind.execute(sa.text(f"DROP INDEX IF EXISTS {sch}.ix_graphs_live"))
    bind.execute(sa.text(f"ALTER TABLE {graphs} DROP COLUMN IF EXISTS deleted_by"))
    bind.execute(sa.text(f"ALTER TABLE {graphs} DROP COLUMN IF EXISTS deleted_at"))
