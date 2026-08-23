"""Merge the counts-history and product-event migration heads.

Revision ID: 20260823_1200_merge_counts_evt
Revises: 20260821_1500_alert_identity, 20260821_1200_event_subject
Create Date: 2026-08-23 12:00

Two heads formed because the counts-history work and the product-event
denormalisation both branched off ``20260817_1400_recon_pause``:

* counts  -> ``20260820_1200_count_history`` -> ``20260821_1200_count_alerts``
             -> ``20260821_1500_alert_identity``
* events  -> ``20260821_1200_event_subject``

They touch disjoint tables -- the two new ``data_source_count_*`` tables plus
columns on ``data_source_stats`` and ``platform_settings``, versus one column
and one index on ``product_events`` -- so there is no reconciliation work. This
is a no-op merge revision that rejoins the heads.

It matters more than a tidy graph: the deploy job
(``deploy/helm/dataviz/templates/upgrade-job.yaml``) runs
``alembic upgrade head`` in the singular, which fails outright while two heads
exist. And per QUICKSTART, column *additions* to existing tables land only
through alembic -- ``create_all`` will not add them -- so without this the
counts columns would silently never appear on an already-provisioned database.

The revision id is 30 characters, inside the 32-char ``alembic_version``
column limit the CI guard enforces.
"""
from __future__ import annotations

from typing import Sequence, Union


revision: str = "20260823_1200_merge_counts_evt"
down_revision: Union[str, Sequence[str], None] = (
    "20260821_1500_alert_identity",
    "20260821_1200_event_subject",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No-op: the two merged chains touch disjoint tables."""
    pass


def downgrade() -> None:
    """No-op: nothing to reverse."""
    pass
