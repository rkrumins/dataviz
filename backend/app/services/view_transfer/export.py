"""Export: turn views into a View Bundle file.

Every exported view names a real version. A view with unsaved changes is sealed first (an
``export`` checkpoint), so the file's ``version`` and ``definitionHash`` point at something that
exists and never changes. Exporting an older version exports exactly that version.

The file also carries, per view:

* a manifest naming every entity the view references (resolved against the source graph, one
  lookup per graph however many views share it), so the importing side can say WHAT didn't
  match, not just how many;
* its history: the version hashes the view has been through, including those carried in from
  earlier imports, which is how a later import finds the version both sides last agreed on.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM, ViewVersionORM
from backend.app.db.repositories import view_repo, view_version_repo
from backend.app.services.view_transfer import limits
from backend.app.services.view_transfer.bundle import assemble_bundle
from backend.app.services.view_transfer.canonical import canonical_json
from backend.app.services.view_transfer.references import (
    URN_KIND_ANCHOR, URN_KIND_ASSIGNMENT, URN_KIND_PREDICATE, URN_KIND_ROOT, URN_KIND_RULE,
    collect, definition_stats, urns_of_kind,
)
from backend.app.services.view_transfer.sources import describe_source, effective_data_source, engine_for

logger = logging.getLogger(__name__)


def environment_id() -> Optional[str]:
    """This deployment's name (dev / uat / prod), when it has one."""
    try:
        from backend.auth_service.core.config import AUTH_ENVIRONMENT_ID
        return AUTH_ENVIRONMENT_ID or None
    except Exception:  # noqa: BLE001
        return None


def product_name() -> Optional[str]:
    try:
        from backend.app.config.branding import get_branding_defaults
        return get_branding_defaults().app_name
    except Exception:  # noqa: BLE001
        return None


@dataclass
class SealedView:
    row: ViewORM
    version: ViewVersionORM
    definition: dict
    label: Dict[str, Any]


async def seal(
    session: AsyncSession, row: ViewORM, version_number: Optional[int], *,
    actor: Optional[str], message: Optional[str], may_seal: bool = True,
) -> SealedView:
    """The version this view exports as: the one asked for, or its current design sealed.

    Sealing unsaved changes writes a version, which only someone who may edit the view does
    (``may_seal``). Anyone else exports its latest version as it stands: reading a view never
    writes to it. (A view with no versions at all gets its first, as reading its history does.)
    """
    if not row.portable_id:
        # A row that predates the column and escaped its backfill: give it an identity now,
        # before it leaves, so its copies can find it again.
        row.portable_id = f"pv_{uuid.uuid4().hex}"
        await session.flush()
    if version_number is not None:
        version = await view_version_repo.get_version(session, row.id, version_number)
        if version is None:
            raise LookupError(f"'{row.name}' has no version {version_number}")
    else:
        head = await view_version_repo.ensure_baseline(session, row)
        if may_seal:
            head, _ = await view_version_repo.checkpoint(
                session, row, source="export", actor=actor, message=message or "Sealed for export",
            )
        version = await view_version_repo.get_version(session, row.id, head.version)
    return SealedView(row=row, version=version,
                      definition=await asyncio.to_thread(view_version_repo.parse_definition, version.definition),
                      label=view_version_repo.label_of(version))


#: How a view's size in a file relates to its canonical design: the file is indented, and its
#: manifest names every entity the view places. Fitted to exported views of 200 to 20,000
#: placements (within a few percent there); an estimate, not a promise.
_FILE_BYTES_PER_DESIGN_BYTE = 2.2
_FILE_BYTES_PER_PLACEMENT = 150


def _measured(definition: dict) -> Tuple[int, Dict[str, int]]:
    return len(canonical_json(definition)), definition_stats(definition)


async def preview(session: AsyncSession, row: ViewORM, *, may_seal: bool) -> Dict[str, Any]:
    """What exporting ``row`` as it stands would write (see ``seal``), without writing anything:
    the version it goes out as, whether that includes unsaved changes, its counts and roughly
    how big it makes the file."""
    latest = await view_version_repo.head(session, row.id)
    state = await view_version_repo.working_state_async(row)
    dirty = (await view_version_repo.status(row, latest, state))["dirty"]
    if latest is None or (dirty and may_seal):
        design_bytes, stats = await asyncio.to_thread(_measured, state.definition)
        exports_as = latest.version + 1 if latest is not None else 1
    else:
        design_bytes = await view_version_repo.stored_size(session, row.id, latest.version)
        stats = view_version_repo.to_summary(latest)["stats"]
        exports_as = latest.version
    ds = await effective_data_source(session, row)
    return {
        "viewId": row.id,
        "name": row.name,
        "workspaceId": row.workspace_id,
        "dataSourceId": ds.id if ds else None,
        "headVersion": latest.version if latest is not None else None,
        "dirty": dirty,
        "maySeal": may_seal,
        "exportsAs": exports_as,
        "includesUnsaved": dirty and may_seal,
        "stats": stats,
        "estimatedBytes": round(design_bytes * _FILE_BYTES_PER_DESIGN_BYTE
                                + int(stats.get("assignments") or 0) * _FILE_BYTES_PER_PLACEMENT),
    }


async def _history(
    session: AsyncSession, sealed: SealedView, rows: List[ViewVersionORM], names: Dict[str, Any],
) -> Tuple[List[dict], bool]:
    """Carried-in ancestry, then this view's own versions (``rows``) up to the exported one."""
    env = environment_id()
    carried: List[dict] = []
    imported = await view_version_repo.latest_of_source(session, sealed.row.id, "import")
    if imported is not None and imported.version <= sealed.version.version and imported.provenance:
        try:
            carried = list(json.loads(imported.provenance).get("ancestry") or [])
        except (TypeError, ValueError, AttributeError):
            carried = []
    own = []
    for v in rows:
        resolved = names.get(v.created_by or "")
        own.append({
            "environment": env, "viewId": sealed.row.id, "version": v.version,
            "hash": v.content_hash, "source": v.source, "createdAt": v.created_at,
            "createdBy": resolved[0] if resolved else None, "message": v.message,
        })
    entries = [e for e in carried if isinstance(e, dict) and e.get("hash")] + own
    truncated = len(entries) > limits.MAX_HISTORY_ENTRIES
    return (entries[-limits.MAX_HISTORY_ENTRIES:] if truncated else entries), truncated


async def export_views(
    session: AsyncSession,
    requests: List[Tuple[ViewORM, Optional[int], bool]],
    *,
    actor: Optional[str],
    message: Optional[str] = None,
) -> Tuple[Dict[str, Any], List[SealedView]]:
    """Build the bundle for ``requests``: each a view, an optional version number, and whether
    the caller may seal the view's unsaved changes (see ``seal``).

    Returns ``(bundle, sealed)``. Raises ``LookupError`` for a version that doesn't exist.
    """
    sealed = [await seal(session, row, number, actor=actor, message=message, may_seal=may_seal)
              for row, number, may_seal in requests]

    # One source entry per distinct (workspace, data source); one identity lookup per source.
    source_keys: Dict[Tuple[str, Optional[str]], str] = {}
    sources: Dict[str, Dict[str, Any]] = {}
    view_source: List[str] = []
    source_engines: Dict[str, Any] = {}
    for item in sealed:
        ds = await effective_data_source(session, item.row)
        key_tuple = (item.row.workspace_id, ds.id if ds else None)
        if key_tuple not in source_keys:
            key = f"s{len(source_keys) + 1}"
            source_keys[key_tuple] = key
            digest = None
            try:
                engine = await engine_for(session, item.row.workspace_id, ds.id if ds else None)
                source_engines[key] = engine
                digest = await engine.get_ontology_digest()
            except Exception as exc:  # noqa: BLE001
                logger.warning("export: source %s unreachable (%s); names won't be resolved", key_tuple, exc)
            sources[key] = await describe_source(session, item.row.workspace_id, ds, ontology_digest=digest)
        view_source.append(source_keys[key_tuple])

    # Walking the designs (their references, stats and manifests) runs in worker threads: seconds
    # for a large view, which on the event loop every other request would wait out.
    refs_of = await asyncio.to_thread(lambda: [collect(item.definition) for item in sealed])
    entities_by_source: Dict[str, Dict[str, Optional[dict]]] = {}
    resolved_ok: Dict[str, bool] = {}
    for key in sources:
        urns = await asyncio.to_thread(lambda key=key: sorted({
            urn
            for refs, item_key in zip(refs_of, view_source) if item_key == key
            for urn in urns_of_kind(refs, URN_KIND_ASSIGNMENT, URN_KIND_ANCHOR,
                                    URN_KIND_RULE, URN_KIND_ROOT, URN_KIND_PREDICATE)
        }))
        engine = source_engines.get(key)
        found: Dict[str, Optional[dict]] = {}
        ok = engine is not None
        if engine is not None and urns:
            try:
                found = await engine.provider.resolve_identities(urns)
                ok = len(found) == len(urns)
            except Exception as exc:  # noqa: BLE001
                logger.warning("export: identity lookup failed for source %s: %s", key, exc)
                ok = False
        entities_by_source[key] = found
        resolved_ok[key] = ok

    history_rows = {
        item.row.id: await view_version_repo.history_upto(session, item.row.id, item.version.version)
        for item in sealed
    }
    names = await view_repo.resolve_user_ids(
        session, {v.created_by for rows in history_rows.values() for v in rows} | {actor})
    entries: List[Dict[str, Any]] = []
    for item, key, refs in zip(sealed, view_source, refs_of):
        found = entities_by_source.get(key, {})
        manifest_entities, counts = await asyncio.to_thread(lambda refs=refs, found=found, item=item: (
            {
                urn: {"name": info.get("name"), "type": info.get("type"), "qualifiedName": info.get("qualifiedName")}
                for urn in sorted(refs.urns)
                if isinstance(info := found.get(urn), dict)
            },
            definition_stats(item.definition),
        ))
        history, truncated = await _history(session, item, history_rows[item.row.id], names)
        entries.append({
            "source": key,
            "portableId": item.row.portable_id,
            "sourceViewId": item.row.id,
            "version": item.version.version,
            "definitionHash": item.version.content_hash,
            "metadata": item.label,
            "definition": item.definition,
            "manifest": {
                "counts": counts,
                "entities": manifest_entities,
                "entitiesResolved": resolved_ok.get(key, False),
            },
            "history": history,
            "historyTruncated": truncated,
        })

    exporter = names.get(actor or "")
    bundle = assemble_bundle(
        views=entries, sources=sources,
        exported_by=exporter[0] if exporter else None,
        product=product_name(), environment=environment_id(),
    )
    return bundle, sealed
