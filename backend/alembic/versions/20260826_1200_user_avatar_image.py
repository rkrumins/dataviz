"""Provider-supplied avatar image on ``users``.

Additive, schema-only. Three columns, all NULL for every existing row:

``avatar_image`` / ``avatar_image_type``
    The picture itself (base64) and its content type. Fetched by the
    server at SSO login from the connection's mapped avatar URL — the
    app's CSP forbids hotlinking a remote image, and re-serving the
    bytes from our own origin is what keeps member lists from beaconing
    every viewer's IP to the IdP's CDN.

``avatar_source_url``
    Where the bytes came from. An unchanged claim skips the refetch; a
    changed one refreshes the image.

``avatar_id`` (the picked illustration) is untouched — the two coexist,
and rendering prefers the provider image while the connection asserts
one.

The ORM (``backend.app.db.models.UserORM``) declares the same columns so
``create_all`` covers fresh and test databases; this migration covers
existing Postgres.
"""
from __future__ import annotations

from typing import Union

from alembic import op
import sqlalchemy as sa

revision: str = "20260826_1200_user_avatar_image"
down_revision: Union[str, None] = "20260824_1500_sso_backchannel"
branch_labels = None
depends_on = None


def upgrade() -> None:
    for column in ("avatar_image", "avatar_image_type", "avatar_source_url"):
        op.add_column(
            "users", sa.Column(column, sa.Text(), nullable=True),
            if_not_exists=True,
        )


def downgrade() -> None:
    # ``op.drop_column`` has no ``if_exists`` (alembic 1.18); raw DDL instead.
    for column in ("avatar_source_url", "avatar_image_type", "avatar_image"):
        op.execute(f"ALTER TABLE users DROP COLUMN IF EXISTS {column}")
