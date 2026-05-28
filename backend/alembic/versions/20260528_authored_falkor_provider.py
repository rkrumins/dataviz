"""Bootstrap the singleton system FalkorDB provider for authored graphs.

Revision ID: 20260528_authored_falkor_provider
Revises: 20260522_1200_view_binding
Create Date: 2026-05-28

Idempotently inserts a ``providers`` row with a stable id
(``prov_sys_authored_falkor``) that the authored-data-source relay
references when it creates ``workspace_data_sources`` rows for newly
authored graphs.

* Host/port read from ``FALKORDB_HOST``/``FALKORDB_PORT`` env at
  migration time. Operators can re-point later via the existing
  provider-edit endpoint; the stable id is what the relay binds to.
* ``provider_type='falkordb'`` reuses the existing FalkorDB driver
  unchanged — authored reads route through ``ContextEngine.for_workspace``
  → ``ProviderManager.get_provider`` against ``graph_name='authored_<id>'``
  with no new provider class.
* ``extra_config`` carries ``{"system": true, "purpose":
  "authored_graphs"}`` so admin UIs can flag it as protected.

Downgrade refuses to drop the row if any ``workspace_data_sources`` row
still references it.
"""
from __future__ import annotations

import json
import os
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260528_authored_falkor_provider"
down_revision: Union[str, None] = "20260522_1200_view_binding"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SYSTEM_PROVIDER_ID = "prov_sys_authored_falkor"


def upgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("providers"):
        return

    host = os.getenv("FALKORDB_HOST", "localhost")
    port = int(os.getenv("FALKORDB_PORT", "6379"))
    extra = json.dumps({"system": True, "purpose": "authored_graphs"})

    bind.execute(
        sa.text(
            "INSERT INTO providers "
            "(id, name, provider_type, host, port, tls_enabled, "
            "is_active, permitted_workspaces, extra_config) "
            "VALUES (:id, :name, 'falkordb', :host, :port, false, "
            "true, :perms, :extra) "
            "ON CONFLICT (id) DO NOTHING"
        ),
        {
            "id": SYSTEM_PROVIDER_ID,
            "name": "System FalkorDB (authored graphs)",
            "host": host,
            "port": port,
            "perms": '["*"]',
            "extra": extra,
        },
    )


def downgrade() -> None:
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("providers"):
        return
    refs = bind.execute(
        sa.text(
            "SELECT COUNT(*) FROM workspace_data_sources "
            "WHERE provider_id = :id"
        ),
        {"id": SYSTEM_PROVIDER_ID},
    ).scalar()
    if refs:
        raise RuntimeError(
            f"Cannot downgrade: {refs} workspace_data_sources row(s) "
            f"reference provider {SYSTEM_PROVIDER_ID!r}. Remove them "
            "first."
        )
    bind.execute(
        sa.text("DELETE FROM providers WHERE id = :id"),
        {"id": SYSTEM_PROVIDER_ID},
    )
