"""A member set's rows, and the lease and fence every step writes through.

A set is moved on by whichever request holds its lease (``take_lease``: free,
expired, or already ours — ``LEASE_S``, renewed by every step). A step reads what
it needs, ends that transaction, makes its one graph call holding no connection,
then writes everything it found in ONE short transaction that ends with
``commit_step``: ``step + 1`` only where the lease is still ours and the step is
still the one it read. A request that lost its lease — it was slow, another took
over — matches no row, and its whole transaction is rolled back: it can never
write over a newer step. A crash between the graph call and the commit writes
nothing, and the step is simply taken again; every write in it is idempotent
(rows are inserted once, distances only shrink, flags are set), so taking it twice
is the same as taking it once.

``SqlWalkStore`` is the walk's store (``walk.WalkStore``) over these rows, plus
the writes the other stages make. Statements stay inside SQLite's variable limit
in tests and well inside Postgres's in production.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, case, func, literal, or_, select, update
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import MemberSetEdgeORM, MemberSetORM, MemberSetRowORM
from backend.app.db.repositories.view_membership_repo import later_iso, now_iso
from backend.app.services.member_sets.walk import Change, Known
from backend.common.models.graph import GraphNode

#: How long a lease holds without a step renewing it.
LEASE_S = 30.0
#: A running set nobody has moved on for this long is let go (``sweeper``).
IDLE_S = 15 * 60

_ROWS = MemberSetRowORM.__table__
_EDGES = MemberSetEdgeORM.__table__


def set_key(scope, spec_hash: str, *, read_in: Optional[str], boundary: str, data_version: str,
            include_edges: bool) -> str:
    """The question's identity: the graph it is read from (workspace, data source,
    branch, physical graph — the cache scope), the spec, and for a query seed the
    view it is searched in and that view's boundary — what ``resolve_cached`` keys a
    Narrow by — then the data it is resolved on, and whether its edges are kept.
    URN seeds pass ``read_in=None, boundary=""``: they are what they are wherever
    they are read."""
    parts = [scope.workspace_id, scope.data_source_id, scope.branch_id, scope.graph_ns, spec_hash,
             read_in or "", boundary, data_version, "edges" if include_edges else ""]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def loads(text: Optional[str], default: Any) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except ValueError:
        return default


async def get(session: AsyncSession, set_id: str) -> Optional[MemberSetORM]:
    """The set as it is now. Steps write with bulk UPDATEs a session's copy does not
    see: every read refreshes it."""
    return (await session.execute(
        select(MemberSetORM).where(MemberSetORM.id == set_id).execution_options(populate_existing=True)
    )).scalar_one_or_none()


async def by_key(session: AsyncSession, key: str) -> Optional[MemberSetORM]:
    return (await session.execute(
        select(MemberSetORM).where(MemberSetORM.key == key).execution_options(populate_existing=True)
    )).scalar_one_or_none()


async def open_set(session: AsyncSession, *, key: str, **fields: Any) -> MemberSetORM:
    """The set for ``key``, started if there is none — or the one there failed: it is
    retired and the question asked again. Two first askers race safely: the loser
    reads the winner's set."""
    found = await by_key(session, key)
    if found is not None and found.status != "failed":
        return found
    if found is not None:
        await retire(session, [found.id])
    now = now_iso()
    ms = MemberSetORM(
        id=f"ms_{uuid.uuid4().hex}", key=key, status="running", stage="seeds", state="{}",
        counts="{}", truncated="[]", member_count=0, edge_count=0, next_seq=0, step=0,
        created_at=now, updated_at=now, expires_at=later_iso(IDLE_S), **fields,
    )
    try:
        async with session.begin_nested():
            session.add(ms)
    except IntegrityError:
        ms = await by_key(session, key)
        if ms is None:
            raise
    return ms


async def retire(session: AsyncSession, set_ids: Sequence[str]) -> int:
    """Expire sets, freeing their key so the question can be asked afresh. Their rows
    stay until the sweeper deletes them."""
    if not set_ids:
        return 0
    result = await session.execute(
        update(MemberSetORM).where(MemberSetORM.id.in_(list(set_ids)))
        .values(status="expired", key=literal("expired:") + MemberSetORM.id, lease_owner=None,
                lease_until=None, updated_at=now_iso())
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0


async def take_lease(session: AsyncSession, set_id: str, owner: str) -> bool:
    """Take (or keep) the right to move the set on: when nobody holds it, its holder's
    lease ran out, or it is already ours. Committed at once."""
    now = now_iso()
    result = await session.execute(
        update(MemberSetORM)
        .where(MemberSetORM.id == set_id, MemberSetORM.status == "running",
               or_(MemberSetORM.lease_owner.is_(None), MemberSetORM.lease_owner == owner,
                   MemberSetORM.lease_until < now))
        .values(lease_owner=owner, lease_until=later_iso(LEASE_S))
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    return result.rowcount == 1


async def release_lease(session: AsyncSession, set_id: str, owner: str) -> None:
    """Let go, so a request waiting on the set can move it on at once."""
    await session.execute(
        update(MemberSetORM).where(MemberSetORM.id == set_id, MemberSetORM.lease_owner == owner)
        .values(lease_owner=None, lease_until=None)
        .execution_options(synchronize_session=False)
    )
    await session.commit()


async def commit_step(session: AsyncSession, set_id: str, owner: str, expected: int,
                      **values: Any) -> bool:
    """The fence: record the step — ``step + 1``, the lease renewed, ``values`` —
    only while the lease is ours and the step is still ``expected``. False: another
    request moved the set on; the caller rolls back everything the step wrote."""
    result = await session.execute(
        update(MemberSetORM)
        .where(MemberSetORM.id == set_id, MemberSetORM.lease_owner == owner,
               MemberSetORM.step == expected, MemberSetORM.status == "running")
        .values(step=MemberSetORM.step + 1, lease_until=later_iso(LEASE_S), updated_at=now_iso(),
                **values)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


async def queued(session: AsyncSession, set_id: str, direction: str) -> int:
    """Members waiting to be walked in ``direction``: how far a lineage stage has to go."""
    return int((await session.execute(
        select(func.count()).select_from(_ROWS)
        .where(_ROWS.c.set_id == set_id, _ROWS.c[f"queued_{_side(direction)}"].is_(True))
    )).scalar() or 0)


def _dialect(session: AsyncSession) -> str:
    return getattr(getattr(getattr(session, "bind", None), "dialect", None), "name", "") or ""


def _chunks(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _side(direction: str) -> str:
    return "up" if direction == "upstream" else "down"


class SqlWalkStore:
    """One step's view of a set's rows: the walk's store, and the writes the other
    stages make. Built afresh for every step from the set as it is — its counters
    advance with what the step writes, and are written by ``commit_step``."""

    def __init__(self, session: AsyncSession, ms: MemberSetORM, *, member_cap: int, edge_cap: int):
        self.session = session
        self.set_id = ms.id
        self.include_edges = bool(ms.include_edges)
        self.next_seq = int(ms.next_seq or 0)
        self.member_count = int(ms.member_count or 0)
        self.edge_count = int(ms.edge_count or 0)
        self.member_cap = member_cap
        self.edge_cap = edge_cap
        self.full = False                # a member was refused: the set is at its cap
        self.refused = 0
        self.edges_seen = 0              # edges past the cap, when it was reached
        postgres = _dialect(session) == "postgresql"
        self._insert = postgresql.insert if postgres else sqlite.insert
        self._least = func.least if postgres else func.min
        self._params = 30_000 if postgres else 900

    # ── reads ───────────────────────────────────────────────────────────────
    async def queue(self, direction: str, limit: int) -> List[Tuple[str, int, Optional[str]]]:
        side = _side(direction)
        hops, queued = _ROWS.c[f"hops_{side}"], _ROWS.c[f"queued_{side}"]
        rows = (await self.session.execute(
            select(_ROWS.c.urn, hops, _ROWS.c.nearest_seed)
            .where(_ROWS.c.set_id == self.set_id, queued.is_(True))
            .order_by(hops, _ROWS.c.seq).limit(limit)
        )).all()
        if not rows:
            return []
        nearest = rows[0][1]
        return [(u, h, o) for u, h, o in rows if h == nearest]

    async def hub(self, direction: str) -> Optional[Tuple[str, str, int, Optional[str]]]:
        side = _side(direction)
        cursor = _ROWS.c[f"cursor_{side}"]
        row = (await self.session.execute(
            select(_ROWS.c.urn, cursor, _ROWS.c[f"hops_{side}"], _ROWS.c.nearest_seed)
            .where(_ROWS.c.set_id == self.set_id, cursor != "")
            .order_by(_ROWS.c.seq).limit(1)
        )).first()
        return tuple(row) if row is not None else None

    async def known_tail(self, direction: str, n: int, skip: Sequence[str]) -> List[str]:
        skipped = set(skip)
        rows = (await self.session.execute(
            select(_ROWS.c.urn)
            .where(_ROWS.c.set_id == self.set_id, _ROWS.c[f"hops_{_side(direction)}"].is_not(None))
            .order_by(_ROWS.c.seq.desc()).limit(n + len(skipped))
        )).scalars().all()
        return [u for u in rows if u not in skipped][:n][::-1]

    async def read(self, direction: str, urns: Sequence[str]) -> Dict[str, Known]:
        side = _side(direction)
        cols = (_ROWS.c.urn, _ROWS.c.via, _ROWS.c[f"hops_{side}"], _ROWS.c[f"walked_{side}"],
                _ROWS.c.nearest_seed, _ROWS.c[f"cursor_{side}"])
        out: Dict[str, Known] = {}
        for chunk in _chunks(list(urns), self._params - 1):
            rows = (await self.session.execute(
                select(*cols).where(_ROWS.c.set_id == self.set_id, _ROWS.c.urn.in_(list(chunk)))
            )).all()
            for urn, via, hops, walked, origin, cursor in rows:
                out[urn] = Known(via=via, hops=hops, walked=-1 if walked is None else walked,
                                 origin=origin, cursor=cursor)
        return out

    async def existing(self, urns: Sequence[str]) -> set:
        found: set = set()
        for chunk in _chunks(list(urns), self._params - 1):
            found.update((await self.session.execute(
                select(_ROWS.c.urn).where(_ROWS.c.set_id == self.set_id, _ROWS.c.urn.in_(list(chunk)))
            )).scalars().all())
        return found

    async def roots(self, vias: Sequence[str], after: int, limit: int) -> List[Tuple[str, int, Optional[str]]]:
        """Members joined for one of ``vias`` after ``after``, in order: whose insides a
        stage reads."""
        return [tuple(r) for r in (await self.session.execute(
            select(_ROWS.c.urn, _ROWS.c.seq, _ROWS.c.nearest_seed)
            .where(_ROWS.c.set_id == self.set_id, _ROWS.c.via.in_(list(vias)), _ROWS.c.seq > after)
            .order_by(_ROWS.c.seq).limit(limit)
        )).all()]

    # ── writes ──────────────────────────────────────────────────────────────
    def _row(self, urn: str, via: str, origin: Optional[str], node: Optional[GraphNode], seq: int,
             **hops: Optional[int]) -> Dict[str, Any]:
        return {
            "set_id": self.set_id, "urn": urn, "seq": seq, "via": via,
            "hops_up": hops.get("hops_up"), "hops_down": hops.get("hops_down"),
            "queued_up": False, "queued_down": False, "whole": False,
            "name": node.display_name if node is not None else None,
            "type": node.entity_type if node is not None else None,
            "qualified_name": node.qualified_name if node is not None else None,
            "nearest_seed": origin,
        }

    def _admit(self, count: int) -> int:
        """How many of ``count`` new members fit under the cap; past it the set is full."""
        room = max(0, self.member_cap - self.member_count)
        if count > room:
            self.full = True
            self.refused += count - room
        return min(count, room)

    async def add_members(self, via: str, found: Sequence[Tuple[str, Optional[str], Optional[GraphNode]]]) -> int:
        """Add entities that join for ``via`` (``(urn, origin, node)``) — those not in
        the set already, in order, up to the cap. Returns how many joined."""
        seen: Dict[str, Tuple[Optional[str], Optional[GraphNode]]] = {}
        for urn, origin, node in found:
            seen.setdefault(urn, (origin, node))
        there = await self.existing(list(seen))
        new = [u for u in seen if u not in there]
        new = new[:self._admit(len(new))]
        rows = []
        for urn in new:
            origin, node = seen[urn]
            rows.append(self._row(urn, via, origin, node, self.next_seq))
            self.next_seq += 1
        for chunk in _chunks(rows, max(1, self._params // len(rows[0]))) if rows else ():
            await self.session.execute(
                self._insert(_ROWS).values(list(chunk)).on_conflict_do_nothing(index_elements=["set_id", "urn"]))
        self.member_count += len(new)
        return len(new)

    async def start_walk(self, direction: str) -> None:
        """The seeds, at distance 0, waiting to be walked in ``direction``."""
        side = _side(direction)
        await self.session.execute(
            update(MemberSetRowORM)
            .where(MemberSetRowORM.set_id == self.set_id, MemberSetRowORM.via == "seed")
            .values({f"hops_{side}": 0, f"queued_{side}": True})
            .execution_options(synchronize_session=False)
        )

    async def mark_whole(self, vias: Sequence[str]) -> None:
        """Everything inside these members is in the set, without being listed."""
        await self.session.execute(
            update(MemberSetRowORM)
            .where(MemberSetRowORM.set_id == self.set_id, MemberSetRowORM.via.in_(list(vias)))
            .values(whole=True).execution_options(synchronize_session=False)
        )

    async def apply(self, direction: str, change: Change) -> int:
        side = _side(direction)
        hops_col = f"hops_{side}"
        new = change.new[:self._admit(len(change.new))]
        refused = {f.urn for f in change.new[len(new):]}
        rows = []
        for f in new:
            rows.append(self._row(f.urn, direction, f.origin, f.node, self.next_seq, **{hops_col: f.hops}))
            self.next_seq += 1
        # A member found nearer keeps the shorter distance — and, for the reason it
        # joined, the seed that is nearer. (Its placeholder seq is never written: the
        # row exists.)
        rows += [self._row(f.urn, direction, f.origin, None, 0, **{hops_col: f.hops}) for f in change.nearer]
        if rows:
            for chunk in _chunks(rows, max(1, self._params // len(rows[0]))):
                stmt = self._insert(_ROWS).values(list(chunk))
                old, new_hops = _ROWS.c[hops_col], stmt.excluded[hops_col]
                stmt = stmt.on_conflict_do_update(index_elements=["set_id", "urn"], set_={
                    hops_col: self._least(func.coalesce(old, new_hops), new_hops),
                    "nearest_seed": case(
                        (and_(_ROWS.c.via == direction, new_hops < func.coalesce(old, new_hops + 1)),
                         stmt.excluded.nearest_seed),
                        else_=_ROWS.c.nearest_seed),
                })
                await self.session.execute(stmt)
        self.member_count += len(new)

        rows_of = and_(_ROWS.c.set_id == self.set_id)
        for chunk in _chunks(change.walked, self._params - 2):
            await self.session.execute(update(_ROWS).where(rows_of, _ROWS.c.urn.in_(list(chunk)))
                                       .values({f"walked_{side}": change.remaining, f"queued_{side}": False}))
        for chunk in _chunks(change.queue, self._params - 1):
            await self.session.execute(update(_ROWS).where(rows_of, _ROWS.c.urn.in_(list(chunk)))
                                       .values({f"queued_{side}": True}))
        for urn, cursor in change.cursors.items():
            await self.session.execute(update(_ROWS).where(rows_of, _ROWS.c.urn == urn)
                                       .values({f"cursor_{side}": cursor}))
        if self.include_edges and change.edges:
            await self._add_edges([e for e in change.edges if e[0] not in refused and e[1] not in refused])
        return len(new)

    async def _add_edges(self, edges: List[Tuple[str, str, str]]) -> None:
        room = max(0, self.edge_cap - self.edge_count)
        if len(edges) > room:
            self.edges_seen = max(self.edges_seen, self.edge_count + len(edges))
            edges = edges[:room]
        rows = []
        for source, target, edge_type in edges:
            rows.append({"set_id": self.set_id, "source_urn": source, "target_urn": target,
                         "edge_type": edge_type, "seq": self.next_seq})
            self.next_seq += 1
        for chunk in _chunks(rows, max(1, self._params // 5)):
            result = await self.session.execute(self._insert(_EDGES).values(list(chunk)).on_conflict_do_nothing(
                index_elements=["set_id", "source_urn", "target_urn", "edge_type"]))
            self.edge_count += max(0, result.rowcount or 0)
