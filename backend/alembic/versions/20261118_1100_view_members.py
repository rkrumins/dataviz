"""Views made from a query: their members out of the view's config, into a table of their own.

``view_members``: each member of such a view at one epoch of its answer — where it is placed,
why it is in, its name for a page in name order. ``view_membership_state`` gains
``members_epoch`` (the epoch readers see) and ``materialize`` (how far a run that outlasts one
request has got). A view of a quarter of a million members cannot keep them in
``views.config``, which every list of views reads.

The members a view already has move here, one view at a time: its ``assignedBy: "query"``
entries leave its config and become rows at its current epoch. The config cannot tell a
member from a container drawn around one, so each such view is marked ``pending``, its
applied hash cleared: the next time it is opened it is worked out again, properly. (The
preview ships off, so few views have any.) The downgrade writes them back, and refuses a
view holding more than the 5,000 entries a config held.

New tables and two nullable columns, so the lock on ``view_membership_state`` is brief; the
wait for it is bounded all the same, and the foreign key locks ``views``. Guarded DDL (a
``create_all`` baseline already has all of it).
Revision id is kept <=32 chars (alembic_version.version_num is VARCHAR(32)).

Revision ID: 20261118_1100_view_members
Revises: 20261118_1000_member_sets
Create Date: 2026-11-18 11:00
"""
from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261118_1100_view_members"
down_revision: Union[str, None] = "20261118_1000_member_sets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: The assignment marker of an entry the server owns (frozen: ``view_membership.MACHINE``).
_MACHINE = "query"
#: The most entries a config held before members moved out (``pipeline.DEFAULT_ENTRY_LIMIT``).
_CONFIG_MAX = 5000
_INSERT_BATCH = 500

_views = sa.table("views", sa.column("id", sa.Text), sa.column("config", sa.Text),
                  sa.column("workspace_id", sa.Text), sa.column("data_source_id", sa.Text))
_state = sa.table(
    "view_membership_state", sa.column("view_id", sa.Text), sa.column("workspace_id", sa.Text),
    sa.column("data_source_id", sa.Text), sa.column("status", sa.Text),
    sa.column("status_detail", sa.Text), sa.column("epoch", sa.Integer),
    sa.column("attempts", sa.Integer), sa.column("revision", sa.Integer),
    sa.column("member_count", sa.Integer), sa.column("key_count", sa.Integer),
    sa.column("applied_resolution_hash", sa.Text), sa.column("members_epoch", sa.Integer),
    sa.column("materialize", sa.Text), sa.column("created_at", sa.Text), sa.column("updated_at", sa.Text),
)
_members = sa.table(
    "view_members", sa.column("view_id", sa.Text), sa.column("epoch", sa.Integer),
    sa.column("urn", sa.Text), sa.column("layer_id", sa.Text), sa.column("sort_key", sa.Text),
    sa.column("ord", sa.Integer), sa.column("label", sa.Text), sa.column("label_ord", sa.Integer),
    sa.column("whole", sa.Boolean), sa.column("covered", sa.Boolean),
    sa.column("assigned_at", sa.Text), sa.column("order_key", sa.Text),
    sa.column("logical_node_id", sa.Text),
)


def _bound_lock_wait() -> None:
    """Wait at most five seconds for a lock: ``views`` is read on every page, and
    giving up (to be run again) beats queueing every read behind a long transaction."""
    if op.get_bind().dialect.name == "postgresql":
        op.execute("SET LOCAL lock_timeout = '5s'")


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _assignments(config: dict):
    """The stored ``referenceLayout.assignments`` dict (created when missing), or None
    for a config with no reference layout at all."""
    layout = config.get("layout")
    ref = layout.get("referenceLayout") if isinstance(layout, dict) else None
    if not isinstance(ref, dict):
        return None
    entries = ref.get("assignments")
    if not isinstance(entries, dict):
        entries = ref["assignments"] = {}
    return entries


def _views_made_from_a_query(bind):
    """Ids of the views whose config names a membership definition: a narrowing
    the database can do, read in full only for those."""
    return bind.execute(sa.select(_views.c.id).where(_views.c.config.like('%"membership"%'))).scalars().all()


def _move_out(bind, view_id: str) -> None:
    row = bind.execute(sa.select(_views).where(_views.c.id == view_id)).first()
    try:
        config = json.loads(row.config or "{}")
    except ValueError:
        return
    if not isinstance(config, dict) or not isinstance(config.get("membership"), dict):
        return
    entries = _assignments(config)
    if entries is None:
        return
    members = {u: e for u, e in entries.items() if isinstance(e, dict) and e.get("assignedBy") == _MACHINE}
    if not members:
        return
    state = bind.execute(sa.select(_state).where(_state.c.view_id == view_id)).first()
    now = _now()
    if state is None:
        bind.execute(_state.insert().values(
            view_id=view_id, workspace_id=row.workspace_id, data_source_id=row.data_source_id,
            status="pending", epoch=0, attempts=0, revision=0, member_count=0, key_count=0,
            created_at=now, updated_at=now))
        epoch, status = 0, "pending"
    else:
        epoch, status = int(state.epoch or 0), state.status
    rows = []
    for ord_, urn in enumerate(sorted(members)):
        e = members[urn]
        if not isinstance(e.get("layerId"), str) or not e["layerId"]:
            continue
        rows.append({
            "view_id": view_id, "epoch": epoch, "urn": urn, "layer_id": e["layerId"],
            # No names here: in URN order until the view is worked out again.
            "sort_key": f"{urn.lower()}\x01{urn}", "ord": len(rows), "label": "", "label_ord": len(rows),
            "whole": e.get("inheritsChildren") is True, "covered": False,
            "assigned_at": e.get("assignedAt"), "order_key": e.get("orderKey"),
            "logical_node_id": e.get("logicalNodeId"),
        })
    for i in range(0, len(rows), _INSERT_BATCH):
        bind.execute(_members.insert(), rows[i:i + _INSERT_BATCH])
    for urn in members:
        entries.pop(urn, None)
    bind.execute(_views.update().where(_views.c.id == view_id).values(config=json.dumps(config)))
    bind.execute(_state.update().where(_state.c.view_id == view_id).values(
        members_epoch=epoch, member_count=len(rows), applied_resolution_hash=None, updated_at=now,
        status=status if status == "frozen" else "pending",
        status_detail=None if status == "frozen" else json.dumps({"reason": "members_moved"})))


def upgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("view_members"):
        op.create_table(
            "view_members",
            sa.Column("view_id", sa.Text(), sa.ForeignKey("views.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("epoch", sa.Integer(), primary_key=True),
            sa.Column("urn", sa.Text(), primary_key=True),
            sa.Column("layer_id", sa.Text(), nullable=False),
            sa.Column("sort_key", sa.Text().with_variant(sa.Text(collation="C"), "postgresql"), nullable=False),
            sa.Column("ord", sa.Integer(), nullable=False),
            sa.Column("label", sa.Text(), nullable=False),
            sa.Column("label_ord", sa.Integer(), nullable=False),
            sa.Column("via", sa.Text(), nullable=True),
            sa.Column("hops", sa.Integer(), nullable=True),
            sa.Column("whole", sa.Boolean(), nullable=False),
            sa.Column("covered", sa.Boolean(), nullable=False),
            sa.Column("name", sa.Text(), nullable=True),
            sa.Column("type", sa.Text(), nullable=True),
            sa.Column("assigned_at", sa.Text(), nullable=True),
            sa.Column("order_key", sa.Text(), nullable=True),
            sa.Column("logical_node_id", sa.Text(), nullable=True),
        )
    op.create_index("idx_vm_feed", "view_members", ["view_id", "epoch", "layer_id", "sort_key", "urn"],
                    if_not_exists=True)
    op.create_index("idx_vm_ord", "view_members", ["view_id", "epoch", "ord"], if_not_exists=True)
    op.create_index("idx_vm_label", "view_members", ["view_id", "epoch", "label", "label_ord"],
                    if_not_exists=True)
    # The members kept whole are a search's roots, read on every search inside the view:
    # a few of a quarter of a million rows, so an index of only them.
    op.create_index("idx_vm_whole", "view_members", ["view_id", "epoch", "ord"], if_not_exists=True,
                    postgresql_where=sa.text("whole"), sqlite_where=sa.text("whole"))

    have = {c["name"] for c in inspector.get_columns("view_membership_state")}
    if "members_epoch" not in have:
        op.add_column("view_membership_state", sa.Column("members_epoch", sa.Integer(), nullable=True))
    if "materialize" not in have:
        op.add_column("view_membership_state", sa.Column("materialize", sa.Text(), nullable=True))

    for view_id in _views_made_from_a_query(bind):
        _move_out(bind, view_id)


def _move_back(bind, view_id: str, epoch: int) -> None:
    rows = bind.execute(sa.select(_members).where(_members.c.view_id == view_id, _members.c.epoch == epoch)
                        .order_by(_members.c.ord)).all()
    config_text = bind.execute(sa.select(_views.c.config).where(_views.c.id == view_id)).scalar()
    try:
        config = json.loads(config_text or "{}")
    except ValueError:
        return
    entries = _assignments(config) if isinstance(config, dict) else None
    if entries is None:
        return
    for r in rows:
        if r.urn in entries:
            continue                    # placed by hand: the person's entry stands
        entry = {"layerId": r.layer_id, "inheritsChildren": bool(r.whole), "assignedBy": _MACHINE}
        for key, value in (("assignedAt", r.assigned_at), ("orderKey", r.order_key),
                           ("logicalNodeId", r.logical_node_id)):
            if value is not None:
                entry[key] = value
        entries[r.urn] = entry
    bind.execute(_views.update().where(_views.c.id == view_id).values(config=json.dumps(config)))


def downgrade() -> None:
    _bound_lock_wait()
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("view_members"):
        held = bind.execute(
            sa.select(_state.c.view_id, _state.c.members_epoch).where(_state.c.members_epoch.is_not(None))
        ).all()
        for view_id, epoch in held:
            count = bind.execute(sa.select(sa.func.count()).select_from(_members).where(
                _members.c.view_id == view_id, _members.c.epoch == epoch)).scalar() or 0
            if count > _CONFIG_MAX:
                raise RuntimeError(
                    f"View {view_id} holds {count:,} members; before this revision a view held at most "
                    f"{_CONFIG_MAX:,}. Make it smaller (or delete it) before downgrading.")
        for view_id, epoch in held:
            _move_back(bind, view_id, epoch)
        for name in ("idx_vm_whole", "idx_vm_label", "idx_vm_ord", "idx_vm_feed"):
            op.drop_index(name, table_name="view_members", if_exists=True)
        op.drop_table("view_members", if_exists=True)
    have = {c["name"] for c in inspector.get_columns("view_membership_state")}
    for column in ("materialize", "members_epoch"):
        if column in have:
            op.drop_column("view_membership_state", column)
