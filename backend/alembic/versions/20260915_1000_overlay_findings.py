"""Clear the alerts the platform raised about its own rollup overlay.

``AGGREGATED`` is the materialised rollup the aggregation pipeline writes —
the platform's own output, not relationships anyone ingested. A rebuild wipes
and rewrites every one of them, so the type disappears and comes back on a
schedule the customer never set. Each disappearance raised a SEVERE
``type_gone`` finding plus a bell notification ("<source>: AGGREGATED is
gone").

``20260902_1000_derived_artifacts`` fixed the sibling case and missed this
one: its step 1 filtered on ``DERIVED_LABELS`` — the node labels — while the
edge type lives in ``DERIVED_EDGE_TYPES``. So the node findings were
acknowledged and the overlay findings were left standing. ``purge_alerts``
only ever deletes ACKNOWLEDGED rows, so they never aged out either: months
later the amber band still reads "AGGREGATED gone · severe" about a rebuild
that worked.

Same two steps as its sibling, and deliberately NOT its third:

1. **Acknowledge, don't delete** — ``acknowledged_by = 'system'``, exactly
   what ``count_alerts_repo.acknowledge`` writes. The band clears now and the
   existing retention prune removes them on its normal schedule. The audit
   trail survives a wrong exclusion list; a hard delete would not.
2. **Mark their notifications read**, so the bell agrees with the band.
3. **No baseline re-seed.** The sibling nulled every ``raw_fingerprint``
   because ``raw_fingerprint_from_counts`` had CHANGED under it. It has
   excluded ``AGGREGATED`` since it was written, so nothing here invalidates a
   baseline — and nulling the fleet's fingerprints with nothing to fix is a
   fleet-wide false positive that queues a rebuild per source.

Narrower than its sibling on purpose, in two ways:

* Filtered on ``finding``/``metric`` as well as ``subject_type``. These are
  EDGE types; a customer entity label spelled ``AGGREGATED`` is their data and
  must keep its findings.
* Matched case-insensitively. ``is_derived_edge_type`` upper-cases
  deliberately — the type reaches us through ``type(r)`` from scans of graphs
  an external system may have loaded, so its casing is not ours to assume.

Idempotent, and safe on a deployment that never produced any of these rows.
``downgrade`` is a no-op on purpose — see the note there.
"""
from __future__ import annotations

from typing import Optional, Union

from alembic import op
import sqlalchemy as sa

from backend.common.derived_artifacts import DERIVED_EDGE_TYPES

revision: str = "20260915_1000_overlay_findings"
down_revision: Union[str, None] = "20260914_1000_converging_clears"
branch_labels = None
depends_on = None

#: ISO-8601 UTC, matching what the repositories write into these Text columns
#: (they store ``datetime.now(timezone.utc).isoformat()``, not a timestamptz).
_NOW_ISO = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"+00:00\"')"


def _has_table(bind, name: str, schema: Optional[str] = None) -> bool:
    """A table the composition does not carry skips its step rather than
    failing the upgrade — the same guard its sibling uses."""
    return sa.inspect(bind).has_table(name, schema=schema)


def upgrade() -> None:
    bind = op.get_bind()
    types = [t.upper() for t in DERIVED_EDGE_TYPES]

    # 1. Acknowledge the findings about our own rollup.
    if _has_table(bind, "data_source_count_alerts"):
        bind.execute(
            sa.text(
                f"""
                UPDATE data_source_count_alerts
                   SET acknowledged_at = {_NOW_ISO},
                       acknowledged_by = 'system'
                 WHERE acknowledged_at IS NULL
                   AND finding = 'type_gone'
                   AND metric = 'edges'
                   AND UPPER(subject_type) IN :types
                """
            ).bindparams(sa.bindparam("types", value=types, expanding=True))
        )

    # 2. Silence their notifications. There is no FK from a notification back
    #    to its alert, and the type lands in the TITLE — notification_repo
    #    builds "<source>: <subject_type> is gone" — so the match is on kind
    #    plus that phrase. Narrow by kind FIRST so a user-authored title that
    #    happens to contain the words cannot be swept up, and compare
    #    upper-cased so a graph loaded with different casing is still covered.
    if _has_table(bind, "notifications"):
        for edge_type in types:
            bind.execute(
                sa.text(
                    f"""
                    UPDATE notifications
                       SET read_at = {_NOW_ISO}
                     WHERE read_at IS NULL
                       AND kind = 'insights.counts_anomaly'
                       AND UPPER(title) LIKE :pattern
                    """
                ).bindparams(sa.bindparam("pattern", value=f"%: {edge_type} IS GONE%"))
            )


def downgrade() -> None:
    # Deliberately a no-op, for the reason its sibling gives: nothing records
    # which rows this acknowledged, so an automated un-acknowledge would also
    # clear acknowledgements a human made. Re-raising them is not desirable
    # anyway — they describe the platform rebuilding its own overlay, which is
    # exactly what the accompanying code change stops reporting.
    pass
