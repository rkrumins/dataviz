"""Update from parent and a fork's merge: ``sync_parent``, ``merging`` and the fork jobs.

* ``commits.kind`` allows ``sync_parent``: a fork's Update from parent writes one commit of its own
  kind on the fork's main, with the base it reads its parent at from there on (``fork_bases``).
* ``merge_requests.status`` allows ``merging``: a fork's review too large to merge inside a request
  is merged by a job, and is ``merging`` until the job ends.
* ``jobs.job_type`` allows ``fork_update`` and ``fork_merge``, those jobs.

Each check is rebuilt once, only while it does not allow its value yet; ``commits`` is checked row
by row as it is, as the migrations before this one that widened it were. The waits for the tables'
locks are bounded (``_bound_lock_wait``), and the upgrade is safe to re-run.

WIDEN-ONLY: each check becomes what the code writes ∪ what it allows now, and the downgrade narrows
nothing — a ``sync_parent`` commit is history, and a job type some row holds is never dropped
(``20261008_1000_jobs_check_widen``).

Mirrored in ``models._ensure_schema_upgrades`` for a separate ``GRAPHVER_DB_URL`` alembic never
reaches.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

from backend.app.services.versioning.models import ensure_fork_sync_checks, widen_job_type_check

revision: str = "20261101_1000_gv_fork_sync"
down_revision: Union[str, None] = "20261030_1200_ds_fork_of"
branch_labels = None
depends_on = None

# What the CODE needs to be able to write, on each side of this migration.
_REQUIRED: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap", "publish",
                            "purge", "package_inspect", "fork_update", "fork_merge")
_REQUIRED_BEFORE: Sequence[str] = ("ingest", "projection", "rebuild", "export", "bootstrap",
                                   "publish", "purge", "package_inspect")


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a table's lock: every save writes ``commits``, so a long
    holder makes the upgrade give up, to be run again, rather than queue those writes behind it."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def upgrade() -> None:
    _bound_lock_wait()
    ensure_fork_sync_checks(op.get_bind())
    widen_job_type_check(op.get_bind(), _REQUIRED)


def downgrade() -> None:
    _bound_lock_wait()
    widen_job_type_check(op.get_bind(), _REQUIRED_BEFORE)
