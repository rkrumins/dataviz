"""Let an operator decide whether profiling SHOWS the rolled-up lineage.

``AGGREGATED`` was stripped from every profiling surface alongside the
platform's bookkeeping NODE labels, and the two are not the same thing.
``_AggMeta`` is a singleton nobody asked to see. The rollup is the lineage
every view draws and a large share of the graph — hiding it made the
relationship-type breakdown total 5.0M against a store holding 5.6M, with
nothing on screen to account for the difference.

So it is shown by default now, and this column is the switch for a deployment
that would rather not. NULL means unset, which resolves to shown.

Governs EDGE types only. The node labels stay hidden unconditionally — see
``common/derived_artifacts``, whose docstring already warns that the two lists
are excluded in different places and neither implies the other.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260915_1100_show_rollup_edges"
down_revision: Union[str, None] = "20260915_1000_overlay_findings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SETTINGS = "platform_settings"
_COLUMN = "profiling_include_derived_edges"


def _columns(inspector, table: str) -> set:
    return {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_SETTINGS):
        return
    if _COLUMN not in _columns(inspector, _SETTINGS):
        # Nullable with no server default: NULL means "nobody has set this",
        # which is a different state from either value an operator could pick.
        op.add_column(_SETTINGS, sa.Column(_COLUMN, sa.Boolean(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table(_SETTINGS):
        return
    if _COLUMN in _columns(inspector, _SETTINGS):
        op.drop_column(_SETTINGS, _COLUMN)
