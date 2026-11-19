"""A view's saved narrowings, in ``view_saved_narrowings``.

A narrowing belongs to the view, not to a branch, and is listed for everyone
who can open it. Each keeps what it held when saved — its URNs, sorted, one a
line and gzipped — which is read on its own (``read_held``), never with the
list.

No write here touches the view's ``updated_at``: a narrowing is not part of
the view's design, and does not travel with its versions or packages.
"""
from __future__ import annotations

import base64
import binascii
import gzip
import json
import zlib
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from backend.app.db.models import ViewSavedNarrowingORM
from backend.app.services.advanced_search_service import (
    ValidationError as SearchValidationError,
    _count_and_validate,
)
from backend.app.services.view_membership_search import seed_query_for
from backend.common.models.view_membership import MembershipSpec
from backend.common.models.view_narrowing import (
    HELD_GZIP_MAX_BYTES,
    HELD_LINE_MAX_BYTES,
    HELD_LINES_MAX,
    HELD_TEXT_MAX_BYTES,
    NARROWINGS_PER_USER,
    NARROWINGS_PER_VIEW,
    SPEC_MAX_BYTES,
    HeldInput,
    HeldSummary,
    SavedNarrowing,
    SavedNarrowingInput,
)


class NarrowingError(Exception):
    """A request refused: ``status`` is the HTTP answer, ``reason`` the code
    a client branches on."""

    def __init__(self, status: int, reason: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.reason = reason
        self.message = message


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def check_spec(raw: Dict[str, Any], *, read_in: str) -> MembershipSpec:
    """``raw`` as a membership spec, in its canonical form — a query seed
    checked as the search it runs in view ``read_in`` — or a 422."""
    try:
        spec = MembershipSpec.model_validate(raw).canonical()
    except PydanticValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()))
        raise NarrowingError(422, "invalid_spec", f"invalid spec{f' at {where}' if where else ''}: "
                                                  f"{first.get('msg', 'not a spec')}") from exc
    if len(_spec_text(spec).encode()) > SPEC_MAX_BYTES:
        raise NarrowingError(422, "invalid_spec", f"The spec is larger than {SPEC_MAX_BYTES // 1024} KB.")
    if spec.seeds.query is not None:
        try:
            _count_and_validate(seed_query_for(spec, read_in))
        except SearchValidationError as exc:
            raise NarrowingError(422, "invalid_spec", str(exc)) from exc
    return spec


def _spec_text(spec: MembershipSpec) -> str:
    return json.dumps(spec.model_dump(mode="json", by_alias=True, exclude_none=True),
                      sort_keys=True, separators=(",", ":"))


def _gunzip(blob: bytes, limit: int) -> bytes:
    """``blob`` unzipped, a member at a time, never more than ``limit`` bytes
    of it: a small file that unzips to gigabytes is refused part-way."""
    out = bytearray()
    while blob:
        unzip = zlib.decompressobj(wbits=31)
        out += unzip.decompress(blob, limit + 1 - len(out))
        if len(out) > limit or unzip.unconsumed_tail:
            raise NarrowingError(422, "held_too_large",
                                 f"The URNs held unzip to more than {limit // (1024 * 1024)} MiB.")
        if not unzip.eof:
            raise NarrowingError(422, "invalid_held", "The URNs held are not a whole gzip file.")
        blob = unzip.unused_data
    return bytes(out)


def canonical_held(held: HeldInput) -> Tuple[bytes, int]:
    """The URNs ``held`` names — blanks dropped, sorted, each once — gzipped
    the same way every time, and how many there are."""
    if len(held.urns_gzip) > (HELD_GZIP_MAX_BYTES + 2) // 3 * 4:
        raise NarrowingError(422, "held_too_large",
                             f"The URNs held are more than {HELD_GZIP_MAX_BYTES // (1024 * 1024)} MiB gzipped.")
    try:
        blob = base64.b64decode(held.urns_gzip, validate=True)
        text = _gunzip(blob, HELD_TEXT_MAX_BYTES).decode("utf-8")
    except (binascii.Error, zlib.error, UnicodeDecodeError) as exc:
        raise NarrowingError(422, "invalid_held",
                             "The URNs held are not base64 of gzipped UTF-8 text.") from exc
    urns = [line.strip() for line in text.split("\n")]
    urns = [u for u in urns if u]
    if len(urns) > HELD_LINES_MAX:
        raise NarrowingError(422, "held_too_large", f"More than {HELD_LINES_MAX:,} URNs held.")
    if any(len(u.encode()) > HELD_LINE_MAX_BYTES for u in urns):
        raise NarrowingError(422, "held_too_large", f"A URN held is longer than {HELD_LINE_MAX_BYTES} bytes.")
    unique = sorted(set(urns))
    data = gzip.compress("\n".join(unique).encode(), compresslevel=9, mtime=0)
    if len(data) > HELD_GZIP_MAX_BYTES:
        raise NarrowingError(422, "held_too_large",
                             f"The URNs held are more than {HELD_GZIP_MAX_BYTES // (1024 * 1024)} MiB gzipped.")
    return data, len(unique)


def _loads(text: Optional[str]) -> Any:
    return json.loads(text) if text else None


def _out(row: ViewSavedNarrowingORM, *, kept: bool, can_change: bool) -> SavedNarrowing:
    return SavedNarrowing(
        id=row.id, view_id=row.view_id, name=row.name, spec=json.loads(row.spec),
        seeds_label=row.seeds_label, seed_names=_loads(row.seed_names),
        counts=_loads(row.counts), truncated=_loads(row.truncated), data_version=row.data_version,
        held=HeldSummary(count=row.held_count, complete=row.held_complete, kept=kept),
        created_by=row.created_by, created_at=row.created_at, updated_at=row.updated_at,
        can_change=can_change,
    )


def _without_held():
    """The rows, and whether each keeps its URNs — without reading them."""
    return (select(ViewSavedNarrowingORM, ViewSavedNarrowingORM.held.is_not(None))
            .options(defer(ViewSavedNarrowingORM.held)))


def may_change(row: ViewSavedNarrowingORM, actor: Optional[str], can_edit: bool) -> bool:
    """Whoever saved it, or anyone who may edit the view."""
    return can_edit or (actor is not None and row.created_by == actor)


async def list_narrowings(session: AsyncSession, view_id: str, *, actor: Optional[str],
                          can_edit: bool) -> List[SavedNarrowing]:
    """The view's narrowings, newest first."""
    rows = (await session.execute(
        _without_held().where(ViewSavedNarrowingORM.view_id == view_id)
        .order_by(ViewSavedNarrowingORM.created_at.desc(), ViewSavedNarrowingORM.id)
    )).all()
    return [_out(row, kept=kept, can_change=may_change(row, actor, can_edit)) for row, kept in rows]


async def _row(session: AsyncSession, view_id: str,
               narrowing_id: str) -> Optional[Tuple[ViewSavedNarrowingORM, bool]]:
    found = (await session.execute(_without_held().where(
        ViewSavedNarrowingORM.view_id == view_id, ViewSavedNarrowingORM.id == narrowing_id,
    ))).first()
    return (found[0], found[1]) if found is not None else None


async def get_narrowing(session: AsyncSession, view_id: str, narrowing_id: str, *,
                        actor: Optional[str], can_edit: bool) -> SavedNarrowing:
    found = await _row(session, view_id, narrowing_id)
    if found is None:
        raise NarrowingError(404, "not_found", f"Narrowing '{narrowing_id}' not found")
    row, kept = found
    return _out(row, kept=kept, can_change=may_change(row, actor, can_edit))


async def read_held(session: AsyncSession, view_id: str, narrowing_id: str) -> Optional[bytes]:
    """The gzipped URNs the narrowing held, or None when it keeps none."""
    found = (await session.execute(select(ViewSavedNarrowingORM.held).where(
        ViewSavedNarrowingORM.view_id == view_id, ViewSavedNarrowingORM.id == narrowing_id,
    ))).first()
    if found is None:
        raise NarrowingError(404, "not_found", f"Narrowing '{narrowing_id}' not found")
    return found[0]


async def put_narrowing(session: AsyncSession, view_id: str, narrowing_id: str,
                        body: SavedNarrowingInput, spec: MembershipSpec, *,
                        actor: Optional[str], can_edit: bool) -> Tuple[SavedNarrowing, bool]:
    """Save a narrowing under ``narrowing_id`` — a new one, or a new version
    of one the caller may change. Everything is replaced as sent, except
    that ``held`` left out keeps the URNs already kept while the spec is the
    same (a read does not carry them back). Returns it, and whether it is
    new."""
    held = canonical_held(body.held) if body.held is not None else None
    spec_text = _spec_text(spec)
    found = await _row(session, view_id, narrowing_id)
    if found is None:
        taken = (await session.execute(
            select(ViewSavedNarrowingORM.view_id).where(ViewSavedNarrowingORM.id == narrowing_id)
        )).scalar_one_or_none()
        if taken is not None:
            raise NarrowingError(409, "id_taken", f"Narrowing id '{narrowing_id}' is taken.")
        on_view = ViewSavedNarrowingORM.view_id == view_id
        total = (await session.execute(select(func.count()).where(on_view))).scalar_one()
        if total >= NARROWINGS_PER_VIEW:
            raise NarrowingError(422, "too_many",
                                 f"A view keeps at most {NARROWINGS_PER_VIEW} saved narrowings.")
        mine = (await session.execute(select(func.count()).where(
            on_view, ViewSavedNarrowingORM.created_by == actor))).scalar_one()
        if mine >= NARROWINGS_PER_USER:
            raise NarrowingError(422, "too_many",
                                 f"You can save at most {NARROWINGS_PER_USER} narrowings on a view.")
        now = _now()
        row = ViewSavedNarrowingORM(id=narrowing_id, view_id=view_id, created_by=actor, created_at=now)
        session.add(row)
        keep_held = False
    else:
        row, kept = found
        if not may_change(row, actor, can_edit):
            raise NarrowingError(403, "not_yours",
                                 "Only whoever saved this narrowing, or an editor of the view, can change it.")
        keep_held = kept and body.held is None and row.spec == spec_text

    row.name, row.spec = body.name, spec_text
    row.seeds_label = body.seeds_label
    row.seed_names = json.dumps(body.seed_names) if body.seed_names is not None else None
    row.counts = (json.dumps(body.counts.model_dump(mode="json", by_alias=True))
                  if body.counts is not None else None)
    row.truncated = (json.dumps([t.model_dump(mode="json", by_alias=True) for t in body.truncated])
                     if body.truncated is not None else None)
    row.data_version = body.data_version
    if held is not None:
        row.held, row.held_count, row.held_complete = held[0], held[1], body.held.complete
    elif not keep_held:
        row.held, row.held_count, row.held_complete = None, 0, True
    row.updated_by, row.updated_at = actor, _now()
    await session.flush()
    return _out(row, kept=held is not None or keep_held, can_change=True), found is None


async def delete_narrowing(session: AsyncSession, view_id: str, narrowing_id: str, *,
                           actor: Optional[str], can_edit: bool) -> None:
    """Remove a narrowing the caller may change (no error when it is gone)."""
    found = await _row(session, view_id, narrowing_id)
    if found is None:
        return
    if not may_change(found[0], actor, can_edit):
        raise NarrowingError(403, "not_yours",
                             "Only whoever saved this narrowing, or an editor of the view, can remove it.")
    await session.execute(delete(ViewSavedNarrowingORM).where(
        ViewSavedNarrowingORM.view_id == view_id, ViewSavedNarrowingORM.id == narrowing_id))
    await session.flush()
