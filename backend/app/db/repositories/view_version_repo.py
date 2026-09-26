"""Checkpoints of a view's design: take one, list them, read one, restore one.

A version is an immutable snapshot of a view's portable definition (see
``backend.app.services.view_transfer.canonical``) plus the label it carried at that moment.
Versions are content-addressed: ``content_hash`` is the SHA-256 of the canonical definition,
so the same design hashes the same in every environment.

Checkpoints are taken at deliberate moments, never per canvas autosave:

  * ``create`` / ``wizard``: a wizard save, taken on its final layout write;
  * ``import``: an imported view, in the import's own transaction;
  * ``restore``: going back to an earlier version (itself a new version, so history is never
    rewritten), preceded by a ``snapshot`` of any unsaved work;
  * ``promote``: a draft's layout folded into the published view;
  * ``export``: sealing unsaved changes so a file always names a real version;
  * ``manual``: "Save version";
  * ``baseline``: the first version of a view that predates versioning, taken lazily the first
    time its history is asked for.

A checkpoint of a view whose design and label haven't changed since the latest version is a
no-op that returns that version, so repeated saves never pile up identical rows.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from backend.app.db.models import ViewORM, ViewVersionORM
from backend.app.services.view_transfer.canonical import (
    canonical_json,
    config_from_definition,
    content_hash,
    portable_definition,
)
from backend.app.services.view_transfer.references import definition_stats

logger = logging.getLogger(__name__)

SOURCES = frozenset({
    "baseline", "create", "wizard", "import", "restore", "promote", "export", "manual", "snapshot",
})

#: The sources a client may claim when it asks for a checkpoint on a layout write. The rest are
#: taken by the server itself and must not be forgeable from outside.
CLIENT_SOURCES = frozenset({"create", "wizard"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_json(raw: Optional[str], default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return default


def _tags_of(raw: Optional[str]) -> List[str]:
    tags = _load_json(raw, [])
    return [t for t in tags if isinstance(t, str)] if isinstance(tags, list) else []


@dataclass
class WorkingState:
    """The view as it is right now, in the terms a version is recorded in."""
    definition: dict
    content_hash: str
    label: Dict[str, Any]


def _inputs(row: ViewORM) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[str]]:
    """What a view's working state is computed from, read off the row. Read here, on the event
    loop: the computation may run in a worker thread, which must never touch an ORM object."""
    return row.config, row.view_type, row.name, row.description, row.tags


def _state_from(config_raw: Optional[str], view_type: Optional[str], name: Optional[str],
                description: Optional[str], tags_raw: Optional[str]) -> WorkingState:
    config = _load_json(config_raw, {})
    if not isinstance(config, dict):
        config = {}
    definition = portable_definition(config, view_type)
    icon = config.get("icon")
    label = {
        "name": name,
        "description": description or None,
        "icon": icon if isinstance(icon, str) and icon else None,
        "tags": _tags_of(tags_raw),
        "viewType": view_type or "graph",
    }
    return WorkingState(definition=definition, content_hash=content_hash(definition), label=label)


def _label_of_version(v: ViewVersionORM) -> Dict[str, Any]:
    return {
        "name": v.name,
        "description": v.description or None,
        "icon": v.icon or None,
        "tags": _tags_of(v.tags),
        "viewType": v.view_type or "graph",
    }


async def working_state_async(row: ViewORM) -> WorkingState:
    """The view as it is right now, worked out in a worker thread. Canonicalising and hashing a
    large view takes seconds (about 1.8 s at 250,000 placements), and on the event loop every
    other request this worker is serving would wait for it."""
    return await asyncio.to_thread(_state_from, *_inputs(row))


def _stored_form(definition: dict) -> Tuple[str, dict]:
    """A version's stored definition and its stats: both walk the whole design."""
    return canonical_json(definition), definition_stats(definition)


async def head(session: AsyncSession, view_id: str) -> Optional[ViewVersionORM]:
    """The latest version of a view, or None when it has none yet.

    Without its definition: every caller of ``head`` compares hashes and labels, and the
    header's status check runs on every view open. Use :func:`get_version` for the design.
    """
    result = await session.execute(
        select(ViewVersionORM)
        .options(defer(ViewVersionORM.definition))
        .where(ViewVersionORM.view_id == view_id)
        .order_by(ViewVersionORM.version.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _next_version(session: AsyncSession, view_id: str) -> int:
    result = await session.execute(
        select(func.max(ViewVersionORM.version)).where(ViewVersionORM.view_id == view_id)
    )
    return int(result.scalar() or 0) + 1


async def stored_size(session: AsyncSession, view_id: str, version: int) -> int:
    """How long a version's stored definition is, without reading it: it can be megabytes."""
    result = await session.execute(
        select(func.length(ViewVersionORM.definition))
        .where(ViewVersionORM.view_id == view_id, ViewVersionORM.version == version)
    )
    return int(result.scalar() or 0)


async def find_by_request_id(session: AsyncSession, request_id: str) -> Optional[ViewVersionORM]:
    if not request_id:
        return None
    result = await session.execute(
        select(ViewVersionORM).where(ViewVersionORM.request_id == request_id)
    )
    return result.scalar_one_or_none()


async def checkpoint(
    session: AsyncSession,
    row: ViewORM,
    *,
    source: str,
    actor: Optional[str] = None,
    message: Optional[str] = None,
    provenance: Optional[dict] = None,
    request_id: Optional[str] = None,
    force: bool = False,
    origin_hash: Optional[str] = None,
) -> Tuple[ViewVersionORM, bool]:
    """Record the view's current design as a new version.

    Returns ``(version, created)``. When neither the design nor the label has changed since
    the latest version, and ``force`` is not set, no row is written and the latest version is
    returned with ``created=False``. ``force`` is for checkpoints that record an EVENT worth
    keeping even when nothing changed shape, such as an import, whose provenance is the point.

    Version numbers come from ``max + 1`` under the ``(view_id, version)`` unique constraint.
    Callers that can race hold the view row ``FOR UPDATE``; a race that slips through fails
    the insert inside a savepoint and is retried once with a fresh number.

    ``origin_hash`` is for imports that stored something other than their file (see
    ``ViewVersionORM.origin_hash``); it is ignored when it equals what was stored.
    """
    if source not in SOURCES:
        raise ValueError(f"unknown version source {source!r}")

    state = await working_state_async(row)
    latest = await head(session, row.id)
    if (not force and latest is not None and latest.content_hash == state.content_hash
            and _label_of_version(latest) == state.label):
        return latest, False

    stored_definition, stats = await asyncio.to_thread(_stored_form, state.definition)
    for attempt in (1, 2):
        number = await _next_version(session, row.id)
        version = ViewVersionORM(
            view_id=row.id,
            version=number,
            content_hash=state.content_hash,
            definition=stored_definition,
            origin_hash=origin_hash if origin_hash and origin_hash != state.content_hash else None,
            name=state.label["name"],
            description=state.label["description"],
            icon=state.label["icon"],
            tags=json.dumps(state.label["tags"]) if state.label["tags"] else None,
            view_type=state.label["viewType"],
            source=source,
            message=(message or None),
            parent_version=latest.version if latest is not None else None,
            stats=json.dumps(stats),
            provenance=json.dumps(provenance) if provenance else None,
            ontology_digest=row.ontology_digest,
            request_id=request_id or None,
            created_by=actor,
            created_at=_now(),
        )
        try:
            async with session.begin_nested():
                session.add(version)
                await session.flush()
            return version, True
        except IntegrityError:
            if request_id:
                # Two copies of the same request raced: the other one won, and it is the
                # answer to both.
                existing = await find_by_request_id(session, request_id)
                if existing is not None:
                    return existing, False
            if attempt == 2:
                raise
            logger.info("checkpoint: version %d of view %s was taken concurrently; retrying",
                        number, row.id)
    raise AssertionError("unreachable")  # pragma: no cover


async def snapshot_if_dirty(session: AsyncSession, row: ViewORM, *, actor: Optional[str], message: str) -> None:
    """Keep the view's current design as a version before something replaces it, even when it
    only existed as unsaved canvas edits: nothing is lost to an import."""
    latest = await ensure_baseline(session, row)
    if (await status(row, latest))["dirty"]:
        await checkpoint(session, row, source="snapshot", actor=actor, message=message)


async def ensure_baseline(session: AsyncSession, row: ViewORM) -> ViewVersionORM:
    """The view's latest version, taking a ``baseline`` first if it has none.

    Views created before versioning existed get their first version here, lazily, rather than
    from a migration that would copy every view's config at once.
    """
    latest = await head(session, row.id)
    if latest is not None:
        return latest
    version, _ = await checkpoint(
        session, row, source="baseline", actor=row.updated_by or row.created_by,
        message="History starts here",
    )
    return version


async def list_versions(
    session: AsyncSession,
    view_id: str,
    *,
    limit: int = 50,
    before: Optional[int] = None,
) -> Tuple[List[ViewVersionORM], bool]:
    """Newest first, without the definitions. Returns ``(page, has_more)``.

    ``before`` is a version number: the page starts just below it (keyset pagination, so a
    long history costs the same to page through at any depth).
    """
    # The definition is the heavy column (a big view's is megabytes) and a history list never
    # shows it, so it is left behind.
    query = (select(ViewVersionORM)
             .options(defer(ViewVersionORM.definition))
             .where(ViewVersionORM.view_id == view_id))
    if before is not None:
        query = query.where(ViewVersionORM.version < before)
    query = query.order_by(ViewVersionORM.version.desc()).limit(limit + 1)
    rows = list((await session.execute(query)).scalars().all())
    return rows[:limit], len(rows) > limit


async def get_version(session: AsyncSession, view_id: str, version: int) -> Optional[ViewVersionORM]:
    """One version, definition included.

    ``populate_existing`` because the same row may already be in the session from a
    definition-less read (``head``/``list_versions``); without it the identity map would hand
    back that copy with the definition still unloaded.
    """
    result = await session.execute(
        select(ViewVersionORM)
        .where(ViewVersionORM.view_id == view_id, ViewVersionORM.version == version)
        .execution_options(populate_existing=True)
    )
    return result.scalar_one_or_none()


async def history_upto(
    session: AsyncSession, view_id: str, upto: int,
) -> List[ViewVersionORM]:
    """Versions 1..``upto`` of a view, oldest first, without definitions: what an exported
    file carries as its history."""
    result = await session.execute(
        select(ViewVersionORM)
        .options(defer(ViewVersionORM.definition))
        .where(ViewVersionORM.view_id == view_id, ViewVersionORM.version <= upto)
        .order_by(ViewVersionORM.version.asc())
    )
    return list(result.scalars().all())


async def latest_of_source(
    session: AsyncSession, view_id: str, source: str,
) -> Optional[ViewVersionORM]:
    """The newest version of ``view_id`` recorded by ``source`` (e.g. its last import)."""
    result = await session.execute(
        select(ViewVersionORM)
        .options(defer(ViewVersionORM.definition))
        .where(ViewVersionORM.view_id == view_id, ViewVersionORM.source == source)
        .order_by(ViewVersionORM.version.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


def parse_definition(raw: Optional[str]) -> dict:
    """A stored definition, decoded. Pure, so it can run in a worker thread: a large view's is
    tens of megabytes."""
    definition = _load_json(raw, {})
    return definition if isinstance(definition, dict) else {}


def base_definition(definition_raw: Optional[str], origin_hash: Optional[str],
                    provenance_raw: Optional[str], base_hash: Optional[str]) -> dict:
    """The design a merge starts from, when the version with these stored columns (its
    ``definition``, ``origin_hash`` and ``provenance``) is the merge base found by ``base_hash``.

    Usually the version's own design. When the base was found through the version's
    ``origin_hash`` (an import that stored something other than its file), it is the FILE's
    design: what the file's side last agreed with, so the choices made on import count as
    changes made here and a merge keeps them. Pure, so it can run in a worker thread.
    """
    if base_hash and origin_hash and base_hash == origin_hash:
        origin = (_load_json(provenance_raw, {}) or {}).get("originDefinition")
        if isinstance(origin, dict):
            return origin
    return parse_definition(definition_raw)


def label_of(version: ViewVersionORM) -> Dict[str, Any]:
    return _label_of_version(version)


async def status(row: ViewORM, latest: Optional[ViewVersionORM],
                 state: Optional[WorkingState] = None) -> Dict[str, Any]:
    """Whether the view has changed since its latest version, and how. Pass ``state`` when the
    caller already has it: working it out again costs as much as the first time."""
    if state is None:
        state = await working_state_async(row)
    design_changed = latest is None or latest.content_hash != state.content_hash
    label_changed = latest is None or _label_of_version(latest) != state.label
    return {
        "headVersion": latest.version if latest is not None else None,
        "headHash": latest.content_hash if latest is not None else None,
        "workingHash": state.content_hash,
        "designChanged": bool(latest is not None and design_changed),
        "labelChanged": bool(latest is not None and label_changed),
        "dirty": bool(latest is not None and (design_changed or label_changed)),
    }


async def restore(
    session: AsyncSession,
    row: ViewORM,
    version_number: int,
    *,
    actor: Optional[str],
    gate_layout=None,
) -> Dict[str, Any]:
    """Make version ``version_number`` the view's current design, as a NEW version.

    Unsaved work is never lost: if the view has changed since its latest version, that state
    is saved first as a ``snapshot``. The restore then writes the old definition and label
    (never visibility, which is a sharing decision rather than part of the design) and records
    a ``restore`` version pointing back at the one it came from.

    ``gate_layout`` is the node-ordering kill switch (``view_repo._gate_node_ordering``); a
    restore is a write like any other and must not reintroduce custom orders an admin has
    turned off. Raises ``LookupError`` when the version doesn't exist.
    """
    target = await get_version(session, row.id, version_number)
    if target is None:
        raise LookupError(f"view {row.id} has no version {version_number}")

    # Held until the caller commits, as a canvas save holds it: a save that landed between the
    # snapshot below and the write would be overwritten without ever being kept as a version.
    await session.refresh(row, with_for_update=True)
    latest = await ensure_baseline(session, row)
    snapshot: Optional[ViewVersionORM] = None
    if (await status(row, latest))["dirty"]:
        snapshot, _ = await checkpoint(
            session, row, source="snapshot", actor=actor,
            message=f"Saved automatically before restoring v{version_number}",
        )

    definition = await asyncio.to_thread(parse_definition, target.definition)
    layout = definition.get("layout")
    if gate_layout is not None and isinstance(layout, dict) and isinstance(layout.get("referenceLayout"), dict):
        layout["referenceLayout"] = await gate_layout(session, layout["referenceLayout"])
    label = label_of(target)
    row.config = await asyncio.to_thread(
        lambda: json.dumps(config_from_definition(definition, icon=label["icon"])))
    row.name = label["name"]
    row.description = label["description"]
    row.tags = json.dumps(label["tags"]) if label["tags"] else None
    row.view_type = label["viewType"]
    if actor is not None:
        row.updated_by = actor
    row.updated_at = _now()
    await session.flush()

    restored, created = await checkpoint(
        session, row, source="restore", actor=actor,
        message=f"Restored v{version_number}",
        provenance={"restoredFrom": version_number, "restoredHash": target.content_hash},
    )
    return {"version": restored, "created": created, "snapshot": snapshot}


#: Provenance kept for the server's own use, not sent to clients: an import's copy of its file's
#: design (``base_definition`` merges from it) and the history it carried (the next export
#: carries it on). Each can be megabytes, and a history page lists up to 200 versions.
_SERVER_ONLY_PROVENANCE = ("originDefinition", "ancestry")


def _client_provenance(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    provenance = _load_json(raw, None)
    if isinstance(provenance, dict):
        return {k: v for k, v in provenance.items() if k not in _SERVER_ONLY_PROVENANCE}
    return provenance


def to_summary(v: ViewVersionORM) -> Dict[str, Any]:
    """A version as the history list shows it: no definition, stats and provenance decoded."""
    return {
        "version": v.version,
        "contentHash": v.content_hash,
        "name": v.name,
        "description": v.description,
        "icon": v.icon,
        "tags": _tags_of(v.tags),
        "viewType": v.view_type,
        "source": v.source,
        "message": v.message,
        "parentVersion": v.parent_version,
        "stats": _load_json(v.stats, {}) or {},
        "provenance": _client_provenance(v.provenance),
        "ontologyDigest": v.ontology_digest,
        "createdBy": v.created_by,
        "createdAt": v.created_at,
    }
