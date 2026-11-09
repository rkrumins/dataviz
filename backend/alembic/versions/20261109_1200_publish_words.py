"""Say which built-in roles publish data, in their descriptions.

Revision ID: 20261109_1200_publish_words
Revises: 20261103_1200_subset_views
Create Date: 2026-11-09 12:00

Since publish enforcement, editing a versioned data source's drafts
(``workspace:datasource:manage``) and publishing them
(``workspace:datasource:publish``) are granted apart. Data engineer has
published since ``20261017_1000_datasource_publish``, and Workspace member
never has, but neither description said so — the words a role picker shows
when someone gives a person or a service account a role. People gave
automation Workspace member expecting it to publish, and met
``403 publish_required``.

Only the description changes, and only where it is still the seeded one: a
description an administrator wrote is kept, and so the role stays as it was
("modified" or not). The permissions are untouched — Data engineer's grant of
publish is the 20261017 migration's, unconditional, and a deployment that
removed it since keeps its choice (Permissions → Roles lists such a role).

Fresh installs get the same words from ``backend.app.config.rbac_seed``, and
``backend.common.role_defaults`` holds them for "Reset to default";
``backend/tests/test_rbac_migration.py`` holds the three together.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261109_1200_publish_words"
down_revision: Union[str, None] = "20261103_1200_subset_views"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


#: role name → (the seeded description before, the description now).
DESCRIPTIONS: dict[str, tuple[str, str]] = {
    "workspace_data_engineer": (
        "Owns data products inside a workspace (datasources, ontology, catalog, views) "
        "without managing members or workspace settings.",
        "Owns data products inside a workspace (datasources, ontology, catalog, views) "
        "and publishes its versioned data sources, without managing members or workspace "
        "settings.",
    ),
    "workspace_member": (
        "Standard workspace member — manage views and data sources.",
        "Standard workspace member — manage views, and change data sources through drafts. "
        "Publishing them needs Publisher or Data engineer.",
    ),
}


def _set(conn, *, frm: int, to: int) -> None:
    now = datetime.now(timezone.utc).isoformat()
    for name, words in DESCRIPTIONS.items():
        conn.execute(
            sa.text(
                "UPDATE roles SET description = :new, updated_at = :now "
                "WHERE name = :name AND description = :old"
            ),
            {"name": name, "old": words[frm], "new": words[to], "now": now},
        )


def upgrade() -> None:
    _set(op.get_bind(), frm=0, to=1)


def downgrade() -> None:
    _set(op.get_bind(), frm=1, to=0)
