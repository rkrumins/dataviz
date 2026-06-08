"""Application branding — white-label singleton.

Revision ID: 20260608_1200_branding
Revises: 20260606_0100_role_expansion
Create Date: 2026-06-08 12:00

Adds the ``application_branding`` singleton table (one row, pinned to
``'singleton'`` by CHECK) carrying the deployment's white-label
identity: app name, logo/favicon (URL or uploaded base64), accent
colour, and legal/contact text.

The row is seeded from the ``APP_BRAND_*`` environment variables (see
``backend.app.config.branding``) so a deployment can rebrand purely
through env config; the admin Settings page overrides those values
live, and the repository falls back to the same env defaults for any
NULL column.

Idempotent (guards table existence + ON CONFLICT DO NOTHING on the
seed). Downgrade drops the table cleanly.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260608_1200_branding"
down_revision: Union[str, None] = "20260606_0100_role_expansion"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector, table: str) -> bool:
    return table in inspector.get_table_names()


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, "application_branding"):
        return

    op.create_table(
        "application_branding",
        sa.Column(
            "id", sa.Text(), primary_key=True, server_default="singleton",
        ),
        sa.Column("app_name", sa.Text(), nullable=True),
        sa.Column("short_name", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("logo_url", sa.Text(), nullable=True),
        sa.Column("logo_data", sa.Text(), nullable=True),
        sa.Column("logo_mime", sa.Text(), nullable=True),
        sa.Column("favicon_url", sa.Text(), nullable=True),
        sa.Column("favicon_data", sa.Text(), nullable=True),
        sa.Column("favicon_mime", sa.Text(), nullable=True),
        sa.Column("accent_color", sa.Text(), nullable=True),
        sa.Column("copyright_text", sa.Text(), nullable=True),
        sa.Column("support_email", sa.Text(), nullable=True),
        sa.Column("login_tagline", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "id = 'singleton'", name="ck_application_branding_singleton",
        ),
    )

    # Seed the singleton from the APP_BRAND_* env defaults. NULLs would
    # also resolve via the repo fallback, but seeding the concrete values
    # makes the row self-describing and keeps exports/backups meaningful.
    from backend.app.config.branding import get_branding_defaults
    d = get_branding_defaults()
    bind.execute(
        sa.text(
            "INSERT INTO application_branding "
            "(id, app_name, short_name, description, logo_url, favicon_url, "
            " accent_color, copyright_text, support_email, login_tagline, "
            " version, updated_at, updated_by) "
            "VALUES ('singleton', :app_name, :short_name, :description, "
            " :logo_url, :favicon_url, :accent_color, :copyright_text, "
            " :support_email, :login_tagline, 1, :now, NULL) "
            "ON CONFLICT (id) DO NOTHING"
        ),
        {
            "app_name": d.app_name,
            "short_name": d.short_name,
            "description": d.description,
            "logo_url": d.logo_url,
            "favicon_url": d.favicon_url,
            "accent_color": d.accent_color,
            "copyright_text": d.copyright_text,
            "support_email": d.support_email,
            "login_tagline": d.login_tagline,
            "now": _now_iso(),
        },
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_table(inspector, "application_branding"):
        op.drop_table("application_branding")
