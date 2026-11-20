"""``view_members``: the members of views made from a query, an epoch of their answer at a time.

Writers:

* the refresh pipeline (``live_views.pipeline``) writes a run's members at its own epoch, a
  page at a time, and swaps ``view_membership_state.members_epoch`` to it once they are all
  there — readers see the last answer until then;
* member operations take a member out at once (kept out, or always included: a person's
  entry now), and a canvas move places one where it was put;
* a layout or design that loses a layer moves the members that sat in it to the fallback
  layer, where the next update places them again.

Every read and write names its epoch, so a run working on the next answer and a reader of the
current one never meet. Statements stay inside SQLite's variable limit in tests and well
inside Postgres's in production.
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from sqlalchemy import and_, delete, exists, func, or_, select, update
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from backend.app.db.models import ViewMemberORM, ViewMembershipStateORM

_ROWS = ViewMemberORM.__table__
#: Rows deleted per transaction when an epoch is let go.
DELETE_BATCH = 50_000
#: Rows read per statement when a whole epoch is read.
READ_BATCH = 5_000


def sort_key(name: Optional[str], urn: str) -> str:
    """Name order, then URN order among equal names. ``\\x01`` (not NUL, which a
    Postgres text cannot hold) sorts below every character a name has."""
    return f"{(name or urn).lower()}\x01{urn}"


def _postgres(session: AsyncSession) -> bool:
    return (getattr(getattr(getattr(session, "bind", None), "dialect", None), "name", "") or "") == "postgresql"


def _params(session: AsyncSession) -> int:
    return 30_000 if _postgres(session) else 900


def _chunks(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


def placement_of(row: Any) -> dict:
    """A member's placement, shaped as an assignment entry is — and how many of its nearest
    containers are drawn in its layer too (``inLayer``)."""
    entry = {"layerId": row.layer_id, "inheritsChildren": bool(row.whole), "inLayer": int(row.in_layer or 0)}
    for key, value in (("assignedAt", row.assigned_at), ("orderKey", row.order_key),
                       ("logicalNodeId", row.logical_node_id)):
        if value is not None:
            entry[key] = value
    return entry


async def insert(session: AsyncSession, rows: Sequence[dict]) -> None:
    """Write rows once: a page taken again after a crash writes nothing twice."""
    if not rows:
        return
    make = postgresql.insert if _postgres(session) else sqlite.insert
    for chunk in _chunks(list(rows), max(1, _params(session) // len(rows[0]))):
        await session.execute(make(_ROWS).values(list(chunk))
                              .on_conflict_do_nothing(index_elements=["view_id", "epoch", "urn"]))


async def placements(session: AsyncSession, view_id: str, epoch: Optional[int],
                     urns: Iterable[str]) -> Dict[str, dict]:
    """Where each of ``urns`` that is a member at ``epoch`` sits — one statement for a
    page (or a canvas save) of URNs."""
    wanted = sorted(set(urns))
    if epoch is None or not wanted:
        return {}
    out: Dict[str, dict] = {}
    for chunk in _chunks(wanted, _params(session) - 2):
        rows = (await session.execute(
            select(_ROWS).where(_ROWS.c.view_id == view_id, _ROWS.c.epoch == epoch, _ROWS.c.urn.in_(list(chunk)))
        )).all()
        out.update({r.urn: placement_of(r) for r in rows})
    return out


async def count(session: AsyncSession, view_id: str, epoch: Optional[int], layer_id: Optional[str] = None) -> int:
    if epoch is None:
        return 0
    query = select(func.count()).select_from(_ROWS).where(_ROWS.c.view_id == view_id, _ROWS.c.epoch == epoch)
    if layer_id is not None:
        query = query.where(_ROWS.c.layer_id == layer_id)
    return int((await session.execute(query)).scalar() or 0)


async def per_layer(session: AsyncSession, view_id: str, epoch: int) -> Dict[str, int]:
    rows = (await session.execute(
        select(_ROWS.c.layer_id, func.count()).where(_ROWS.c.view_id == view_id, _ROWS.c.epoch == epoch)
        .group_by(_ROWS.c.layer_id)
    )).all()
    return {layer: int(n) for layer, n in rows}


async def page(session: AsyncSession, view_id: str, epoch: int, layer_id: str,
               after: Optional[Tuple[str, str]], limit: int) -> List[Any]:
    """A layer's members in name order, ``limit`` after the keyset ``after``
    (``(sort_key, urn)``): one index range read (``idx_vm_feed``)."""
    query = select(_ROWS).where(_ROWS.c.view_id == view_id, _ROWS.c.epoch == epoch, _ROWS.c.layer_id == layer_id)
    if after is not None:
        key, urn = after
        query = query.where(or_(_ROWS.c.sort_key > key, and_(_ROWS.c.sort_key == key, _ROWS.c.urn > urn)))
    return list((await session.execute(query.order_by(_ROWS.c.sort_key, _ROWS.c.urn).limit(limit))).all())


async def urns(session: AsyncSession, view_id: str, epoch: Optional[int], limit: Optional[int] = None,
               *, whole: bool = False, layer_id: Optional[str] = None) -> List[str]:
    """An epoch's member URNs, in the order they were found — only those kept whole, with
    ``whole``; only one layer's, with ``layer_id``."""
    if epoch is None:
        return []
    query = (select(_ROWS.c.urn).where(_ROWS.c.view_id == view_id, _ROWS.c.epoch == epoch)
             .order_by(_ROWS.c.ord))
    if whole:
        query = query.where(_ROWS.c.whole.is_(True))
    if layer_id is not None:
        query = query.where(_ROWS.c.layer_id == layer_id)
    if limit is not None:
        query = query.limit(limit)
    return list((await session.execute(query)).scalars().all())


async def as_assignments(session: AsyncSession, view_id: str, epoch: Optional[int]) -> Dict[str, dict]:
    """An epoch's members as the server's assignment entries (``assignedBy: "query"``),
    read ``READ_BATCH`` at a time: what a design that places them (a package's data, a
    view-scoped export) reads."""
    from backend.common.models.view_membership import MACHINE

    out: Dict[str, dict] = {}
    if epoch is None:
        return out
    after = -1
    while True:
        rows = (await session.execute(
            select(_ROWS).where(_ROWS.c.view_id == view_id, _ROWS.c.epoch == epoch, _ROWS.c.ord > after)
            .order_by(_ROWS.c.ord).limit(READ_BATCH)
        )).all()
        for r in rows:
            out[r.urn] = {**placement_of(r), "assignedBy": MACHINE}
        if len(rows) < READ_BATCH:
            return out
        after = rows[-1].ord


async def with_members(session: AsyncSession, view_id: str, design: dict) -> dict:
    """``design`` (a config, or a version's definition) with the view's members as its
    server entries, for what reads a design's placements: a view made from a query keeps
    them here, never in its design. Any other view's design is returned as it is."""
    import copy

    if not isinstance(design.get("membership"), dict):
        return design
    state = (await session.execute(
        select(ViewMembershipStateORM.members_epoch).where(ViewMembershipStateORM.view_id == view_id)
    )).scalar_one_or_none()
    members = await as_assignments(session, view_id, state)
    if not members:
        return design
    out = copy.deepcopy(design)
    layout = out.get("layout") if isinstance(out.get("layout"), dict) else out.setdefault("layout", {})
    ref = layout.get("referenceLayout") if isinstance(layout.get("referenceLayout"), dict) else None
    if ref is None:
        ref = layout["referenceLayout"] = {}
    ref["assignments"] = {**members, **(ref.get("assignments") or {})}
    return out


async def diff(session: AsyncSession, view_id: str, old: Optional[int], new: int,
               sample: int = 50) -> Dict[str, Any]:
    """What changed from epoch ``old`` to ``new``, measured in SQL: how many members
    joined, left and moved layer, how many changed otherwise (``touched``: a name, how
    much of them is in, where in a layer, what it is drawn inside), how many there were
    (``before``), and a sample of who joined and left."""
    new_rows = select(_ROWS).where(_ROWS.c.view_id == view_id, _ROWS.c.epoch == new).subquery()
    if old is None:
        added = int((await session.execute(select(func.count()).select_from(new_rows))).scalar() or 0)
        added_sample = list((await session.execute(
            select(new_rows.c.urn).order_by(new_rows.c.ord).limit(sample))).scalars().all())
        return {"added": added, "removed": 0, "moved": 0, "touched": 0, "before": 0,
                "addedSample": added_sample, "removedSample": []}
    a, b = aliased(ViewMemberORM), aliased(ViewMemberORM)

    def only_in(this: int, other: int):
        return (select(a.urn).where(a.view_id == view_id, a.epoch == this, ~exists().where(
            b.view_id == view_id, b.epoch == other, b.urn == a.urn)))

    async def n(query) -> int:
        return int((await session.execute(select(func.count()).select_from(query.subquery()))).scalar() or 0)

    both = (select(a.urn).join(b, and_(b.view_id == a.view_id, b.urn == a.urn, b.epoch == old))
            .where(a.view_id == view_id, a.epoch == new))
    touched_on = [a.whole != b.whole, a.covered != b.covered, a.sort_key != b.sort_key,
                  a.label != b.label, a.via.is_distinct_from(b.via), a.hops.is_distinct_from(b.hops),
                  a.order_key.is_distinct_from(b.order_key),
                  a.logical_node_id.is_distinct_from(b.logical_node_id), a.in_layer != b.in_layer]
    return {
        "added": await n(only_in(new, old)),
        "removed": await n(only_in(old, new)),
        "moved": await n(both.where(a.layer_id != b.layer_id)),
        "touched": await n(both.where(a.layer_id == b.layer_id, or_(*touched_on))),
        "before": await count(session, view_id, old),
        "addedSample": list((await session.execute(only_in(new, old).order_by(a.ord).limit(sample))).scalars().all()),
        "removedSample": list((await session.execute(only_in(old, new).order_by(a.ord).limit(sample))).scalars().all()),
    }


async def drop(session: AsyncSession, view_id: str, epoch: Optional[int], gone: Iterable[str]) -> int:
    """Take members out of an epoch at once (kept out, or a person's own entry now)."""
    wanted = sorted(set(gone))
    if epoch is None or not wanted:
        return 0
    dropped = 0
    for chunk in _chunks(wanted, _params(session) - 2):
        result = await session.execute(
            delete(ViewMemberORM).where(ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == epoch,
                                        ViewMemberORM.urn.in_(list(chunk)))
            .execution_options(synchronize_session=False))
        dropped += result.rowcount or 0
    return dropped


async def move(session: AsyncSession, view_id: str, epoch: Optional[int], moves: Mapping[str, dict]) -> None:
    """Place members where a person put them (assignment-shaped placements)."""
    if epoch is None:
        return
    for urn, placed in moves.items():
        await session.execute(
            update(ViewMemberORM).where(ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == epoch,
                                        ViewMemberORM.urn == urn)
            .values(layer_id=placed["layerId"], order_key=placed.get("orderKey"),
                    logical_node_id=placed.get("logicalNodeId"))
            .execution_options(synchronize_session=False))


async def rehome(session: AsyncSession, view_id: str, epoch: Optional[int], layer_ids: Sequence[str],
                 fallback_layer_id: Optional[str]) -> int:
    """Members whose layer is gone wait in the fallback layer (the first, when the
    view names none) until the next update places them again. Returns how many moved."""
    layers = [l for l in layer_ids if l]
    fallback = fallback_layer_id if fallback_layer_id in layers else (layers[0] if layers else None)
    if epoch is None or fallback is None:
        return 0
    result = await session.execute(
        update(ViewMemberORM).where(ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == epoch,
                                    ViewMemberORM.layer_id.notin_(layers))
        .values(layer_id=fallback, order_key=None, logical_node_id=None)
        .execution_options(synchronize_session=False))
    return result.rowcount or 0


async def members_epoch(session: AsyncSession, view_id: str) -> Optional[int]:
    """The epoch of the view's members that readers see, None before its first answer."""
    return (await session.execute(
        select(ViewMembershipStateORM.members_epoch).where(ViewMembershipStateORM.view_id == view_id)
    )).scalar_one_or_none()


#: URNs asked about per statement when a search checks which are members.
HOLDS_BATCH = 1_000


class SearchMembers:
    """One epoch's members as a search reads them when they are too many to list as its
    roots (``deep_search.ViewMembers``). A search runs its units side by side and a
    database session answers one statement at a time, so its reads take turns.
    ``layer_id``: one layer's members only (a layer filter in the view)."""

    def __init__(self, session: AsyncSession, view_id: str, epoch: int, count: int,
                 layer_id: Optional[str] = None) -> None:
        self._session, self._view_id, self._epoch, self.count = session, view_id, epoch, count
        self._layer_id = layer_id
        self._turn = asyncio.Lock()

    def _of(self) -> tuple:
        here = (_ROWS.c.view_id == self._view_id, _ROWS.c.epoch == self._epoch)
        return here if self._layer_id is None else (*here, _ROWS.c.layer_id == self._layer_id)

    def _searched(self) -> tuple:
        """The members a search reads itself: a whole one is a root, and one inside a
        whole one (``covered``) is read under it — but in one layer, where the whole one
        around it (in another layer) is not a root, it is read itself."""
        if self._layer_id is not None:
            return (*self._of(), _ROWS.c.whole.is_(False))
        return (*self._of(), _ROWS.c.whole.is_(False), _ROWS.c.covered.is_(False))

    async def counts(self) -> Dict[str, Tuple[int, int]]:
        async with self._turn:
            rows = (await self._session.execute(
                select(_ROWS.c.label, func.count(), func.max(_ROWS.c.label_ord))
                .where(*self._searched()).group_by(_ROWS.c.label))).all()
        return {label: (int(n), int(last) + 1) for label, n, last in rows}

    async def read(self, label: str, lo: int, hi: int) -> List[str]:
        """One index range (``idx_vm_label``)."""
        async with self._turn:
            return list((await self._session.execute(
                select(_ROWS.c.urn).where(*self._searched(), _ROWS.c.label == label,
                                          _ROWS.c.label_ord >= lo, _ROWS.c.label_ord < hi)
                .order_by(_ROWS.c.label_ord))).scalars().all())

    async def holds(self, urns: Sequence[str]) -> Set[str]:
        found: Set[str] = set()
        async with self._turn:
            for chunk in _chunks(sorted(set(urns)), min(HOLDS_BATCH, _params(self._session) - 2)):
                found.update((await self._session.execute(
                    select(_ROWS.c.urn).where(*self._of(), _ROWS.c.urn.in_(list(chunk))))).scalars().all())
        return found


async def rehome_view(session: AsyncSession, view_id: str, config: dict) -> int:
    """``rehome`` for a design replaced wholesale (a version restored, a file imported
    over the view): its members wait in its fallback layer where theirs is gone."""
    from backend.app.services.live_views.ownership import layer_ids_of
    from backend.common.models.view_membership import read_definition

    definition = read_definition(config)
    layout = config.get("layout") if isinstance(config.get("layout"), dict) else {}
    ref = layout.get("referenceLayout") if isinstance(layout.get("referenceLayout"), dict) else {}
    if definition is None:
        return 0
    return await rehome(session, view_id, await members_epoch(session, view_id), layer_ids_of(ref),
                        definition.layout.fallback_layer_id)


async def delete_epoch(session: AsyncSession, view_id: str, epoch: int, *, batch: int = DELETE_BATCH) -> int:
    """Delete up to ``batch`` of an epoch's rows (by ``ord``, so each statement is one
    index range): call until it returns 0."""
    first = (await session.execute(
        select(func.min(ViewMemberORM.ord)).where(ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == epoch)
    )).scalar()
    if first is None:
        return 0
    result = await session.execute(
        delete(ViewMemberORM).where(ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == epoch,
                                    ViewMemberORM.ord < first + batch)
        .execution_options(synchronize_session=False))
    return result.rowcount or 0


async def replace(session: AsyncSession, state: ViewMembershipStateORM, view_id: str,
                  entries: Mapping[str, dict], *, names: Mapping[str, Tuple[str, str]] = {}) -> None:
    """A snapshot's members as a file (or an older version) carried them: they become its
    members at a new epoch — in name order where ``names`` (urn → (name, type)) has them,
    else in URN order, until it is worked out again."""
    epoch = int(state.epoch or 0) + 1
    rows = []
    labels: Dict[str, int] = {}
    # Numbered in the order pages list them: by name where ``names`` has one, else by URN.
    for urn in sorted(entries, key=lambda u: sort_key((names.get(u) or (None, None))[0], u)):
        entry = entries[urn]
        if not isinstance(entry, Mapping) or not isinstance(entry.get("layerId"), str):
            continue
        name, kind = names.get(urn) or (None, None)
        label = kind or ""
        rows.append({
            "view_id": view_id, "epoch": epoch, "urn": urn, "layer_id": entry["layerId"],
            "sort_key": sort_key(name, urn), "ord": len(rows), "label": label,
            "label_ord": labels.get(label, 0),
            "whole": entry.get("inheritsChildren") is True, "covered": False, "name": name, "type": kind,
            "assigned_at": entry.get("assignedAt"), "order_key": entry.get("orderKey"),
            "logical_node_id": entry.get("logicalNodeId"),
            "in_layer": entry["inLayer"] if isinstance(entry.get("inLayer"), int) and entry["inLayer"] > 0 else 0,
        })
        labels[label] = labels.get(label, 0) + 1
    await insert(session, rows)
    previous = state.members_epoch
    state.epoch, state.members_epoch, state.member_count = epoch, epoch, len(rows)
    if previous is not None:
        while await delete_epoch(session, view_id, previous):
            pass
