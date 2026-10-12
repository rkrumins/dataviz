"""Clear the alerts the platform raised about its own bookkeeping nodes.

``_AggMeta`` / ``_Projection`` / ``_GVRollupMeta`` are written by the
aggregation pipeline and the versioning projector, not ingested by anyone. Two
provider count paths (``get_stats``, ``get_counts_fast``) never excluded them,
so they reached the profiling snapshots as ordinary entity types — and because
``_AggMeta`` is MERGEd per aggregation run while projection seeds and purges
wipe it, it toggles 1 -> 0 -> 1. Every dip raised a SEVERE ``type_gone``
finding plus a bell notification ("<source>: _AggMeta is gone").

The code fix stops new ones and filters old snapshots on read. This migration
deals with what was already written:

1. **Acknowledge, don't delete.** Findings are stamped
   ``acknowledged_by = 'system'`` exactly as ``count_alerts_repo.acknowledge``
   would, which clears the amber band immediately and hands them to the
   existing retention prune (which only removes ACKNOWLEDGED alerts) on its
   normal schedule. The audit trail survives; a hard delete would destroy it
   and could not be undone if the exclusion list were ever wrong.
2. **Mark their notifications read**, so the bell agrees with the band.
3. **Re-seed the drift baselines.** ``raw_fingerprint_from_counts`` now
   excludes the derived labels, so every stored baseline was computed under
   the old rule and would read as drift on the next sweep — a fleet-wide
   false positive, each one queueing a rebuild with nothing to fix. Setting
   the column to NULL uses the mechanism already designed for exactly this:
   the ORM comment on ``data_source_state.raw_fingerprint`` records that NULL
   means "never seen — the sweep seeds it and acts on nothing, which is what
   stops a fleet-wide storm on first run."

Idempotent, and safe on a deployment that never produced any of these rows.
``downgrade`` is a no-op on purpose — see the note there.
"""
from __future__ import annotations

from typing import Optional, Union

from alembic import op
import sqlalchemy as sa

from backend.common.derived_artifacts import DERIVED_LABELS

revision: str = "20260902_1000_derived_artifacts"
down_revision: Union[str, None] = "20260827_1000_system_account"
branch_labels = None
depends_on = None

#: ISO-8601 UTC, matching what the repositories write into these Text columns
#: (they store ``datetime.now(timezone.utc).isoformat()``, not a timestamptz).
_NOW_ISO = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"+00:00\"')"


def _has_table(bind, name: str, schema: Optional[str] = None) -> bool:
    """The aggregation schema is owned by a separate service and may not be
    present in every composition; a missing table skips its step rather than
    failing the upgrade."""
    return sa.inspect(bind).has_table(name, schema=schema)


def upgrade() -> None:
    bind = op.get_bind()
    labels = list(DERIVED_LABELS)

    # 1. Acknowledge the findings about our own nodes.
    if _has_table(bind, "data_source_count_alerts"):
        bind.execute(
            sa.text(
                f"""
                UPDATE data_source_count_alerts
                   SET acknowledged_at = {_NOW_ISO},
                       acknowledged_by = 'system'
                 WHERE acknowledged_at IS NULL
                   AND subject_type IN :labels
                """
            ).bindparams(sa.bindparam("labels", value=labels, expanding=True))
        )

    # 2. Silence their notifications. There is no FK from a notification back
    #    to its alert, and the label lands in the TITLE — notification_repo
    #    builds "<source>: <subject_type> is gone" — so the match is on kind
    #    plus that phrase. Narrow by kind first so a user-authored title that
    #    happens to contain the words cannot be swept up.
    if _has_table(bind, "notifications"):
        for label in labels:
            bind.execute(
                sa.text(
                    f"""
                    UPDATE notifications
                       SET read_at = {_NOW_ISO}
                     WHERE read_at IS NULL
                       AND kind = 'insights.counts_anomaly'
                       AND title LIKE :pattern
                    """
                ).bindparams(sa.bindparam("pattern", value=f"%: {label} is gone%"))
            )

    # 3. Re-seed the drift baselines (see the module docstring).
    if _has_table(bind, "data_source_state", schema="aggregation"):
        bind.execute(
            sa.text(
                "UPDATE aggregation.data_source_state "
                "   SET raw_fingerprint = NULL "
                " WHERE raw_fingerprint IS NOT NULL"
            )
        )


def downgrade() -> None:
    # Deliberately a no-op. Nothing records which rows this migration
    # acknowledged, so an automated un-acknowledge would also clear
    # acknowledgements a human made. Re-raising the findings is not desirable
    # anyway — they described the platform's own bookkeeping, which is exactly
    # what the accompanying code change stops reporting.
    pass
