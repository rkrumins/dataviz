"""Let the profiling ledger record a check that could not measure the graph.

A failed collection wrote nothing at all. That was deliberate — the concern was
that a failed scan must never enter the series as a zero, because a phantom
wipe is far worse than a gap. But it left an operator unable to answer the
question they actually open the page with: was this source even checked?
Silence looked identical whether the pipeline had stopped, the provider was
refusing, or nothing had changed for a week.

``capture_reason = 'unavailable'`` closes that without giving up the original
constraint. Such a row carries the LAST KNOWN counts forward — never a
fabricated zero, and never written at all when there is no prior observation to
carry (see ``stats_history_repo.record_unavailable``) — so the drawn series is
unchanged and only the reason and the new ``check_error`` say what happened.
It is heartbeat-gated like a continuity tick, so an outage that retries every
60s produces one row per window rather than a wall of them.

Widen-only, matching ``20260824_1200_snapshot_run``: the CHECK is rebuilt over
the required set unioned with whatever is already stored, so a database that
somehow holds an unexpected value is never made un-writable by this migration.

``downgrade`` reclassifies ``unavailable`` rows as ``heartbeat`` rather than
deleting them: they are real observations of a real instant, and the older
schema has a place for them. The column is dropped last.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260908_1100_check_unavailable"
down_revision: Union[str, None] = "20260908_1000_discovery_attempt"
branch_labels = None
depends_on = None

_SNAPSHOTS = "data_source_count_snapshots"
_CONSTRAINT = "ck_dscs_reason"
_REASONS_AFTER = ("first", "changed", "heartbeat", "run", "unavailable")
_REASONS_BEFORE = ("first", "changed", "heartbeat", "run")


def _columns(bind, table: str) -> set:
    inspector = sa.inspect(bind)
    if not inspector.has_table(table):
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def _rebuild_reason_check(bind, required: Sequence[str]) -> None:
    """Rebuild the reason CHECK over ``required`` union whatever is stored.

    Same helper as ``20260824_1200_snapshot_run._widen_reason_check``. A fresh
    database never reaches here — ``create_all`` lays the widened CHECK down
    directly and never ALTERs — and SQLite cannot ALTER a CHECK at all, so the
    tests (which build from the ORM) have nothing to reconcile.
    """
    inspector = sa.inspect(bind)
    if not inspector.has_table(_SNAPSHOTS):
        return
    if bind.dialect.name == "sqlite":
        return
    present = {
        row[0]
        for row in bind.execute(
            sa.text(f"SELECT DISTINCT capture_reason FROM {_SNAPSHOTS}")
        )
        if row[0]
    }
    allowed = sorted(set(required) | present)
    values = ", ".join("'" + v.replace("'", "''") + "'" for v in allowed)
    bind.execute(sa.text(
        f"ALTER TABLE {_SNAPSHOTS} DROP CONSTRAINT IF EXISTS {_CONSTRAINT}"
    ))
    bind.execute(sa.text(
        f"ALTER TABLE {_SNAPSHOTS} ADD CONSTRAINT {_CONSTRAINT} "
        f"CHECK (capture_reason IN ({values}))"
    ))


def upgrade() -> None:
    bind = op.get_bind()
    cols = _columns(bind, _SNAPSHOTS)
    if not cols:
        return
    if "check_error" not in cols:
        op.add_column(_SNAPSHOTS, sa.Column("check_error", sa.Text(), nullable=True))
    _rebuild_reason_check(bind, _REASONS_AFTER)


def downgrade() -> None:
    bind = op.get_bind()
    cols = _columns(bind, _SNAPSHOTS)
    if not cols:
        return
    # Reclassify rather than delete: an ``unavailable`` row is a real
    # observation of a real instant, and ``heartbeat`` is the older schema's
    # word for "the system confirmed stillness". Must run BEFORE the narrowed
    # CHECK goes back on, or the UPDATE would violate it mid-flight.
    bind.execute(sa.text(
        f"UPDATE {_SNAPSHOTS} SET capture_reason = 'heartbeat' "
        f"WHERE capture_reason = 'unavailable'"
    ))
    _rebuild_reason_check(bind, _REASONS_BEFORE)
    if "check_error" in cols:
        op.drop_column(_SNAPSHOTS, "check_error")
