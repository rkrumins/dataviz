"""Collect how many property NAMES each graph has registered, with history.

FalkorDB numbers property names with a 16-bit id per graph and never frees
one, so the count is a ratchet: it only goes up, and a graph that reaches
65,534 can no longer register the names a rollup write needs and can only be
recreated. A production graph reached that ceiling with nothing anywhere
having recorded it climbing — the only reading that existed was
``run_stats.attribute_names``, written by an aggregation REBUILD, so a source
that had never rebuilt was invisible and a source that had showed one number
with no trend behind it.

Three columns, one per tier of the counts pipeline, so the figure travels the
same road the node and edge counts already do: current state, the append-only
observation, and the compacted bucket.

NULLABLE, and null is not zero. A provider that cannot answer, a store that
is not FalkorDB, and every row captured before this shipped all mean "not
measured", and a graph nobody could measure must never read as a graph
carrying no properties — a zero would draw a floor on the chart and make the
headroom look infinite. Every reader has to treat null as unknown.

History is NOT retrospective. Unlike the aggregated overlay, which was
recoverable from ``edge_type_counts`` rows already on disk, nothing stored
this before now, so the series starts at the first capture after deploy.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260916_1100_property_key_count"
down_revision: Union[str, None] = "20260916_1000_property_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMN = "property_key_count"
_TABLES = (
    "data_source_stats",
    "data_source_count_snapshots",
    "data_source_count_rollups",
)


def _has_column(bind, table: str) -> bool:
    return _COLUMN in {
        c["name"] for c in sa.inspect(bind).get_columns(table)
    }


def upgrade() -> None:
    bind = op.get_bind()
    for table in _TABLES:
        # Guarded so a database that already took the column — a re-run, or a
        # restore from a dump taken after it landed — upgrades instead of
        # failing the whole chain on one ALTER.
        if _has_column(bind, table):
            continue
        op.add_column(
            table, sa.Column(_COLUMN, sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_TABLES):
        if not _has_column(bind, table):
            continue
        op.drop_column(table, _COLUMN)
