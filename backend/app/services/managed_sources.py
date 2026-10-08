"""Data sources the platform provisions itself, and who reads one physical graph key.

A FalkorDB graph is addressed by (provider, graph name), and nothing stops two data sources — in
one workspace or in two — from reading the same key, or a catalog entry from publishing it. Any
action that CHANGES a key in place therefore has to ask who else reads it first: collapsing a
bootstrap's duplicate nodes deletes them from the source graph for every reader, and a purge must
not drop a key someone else still uses (:func:`graph_key_bindings`).

A MANAGED data source is one whose graph the platform itself writes: a blank model
(``POST /versioning/blank-graphs``) or a new source seeded from a view package
(``POST /views/transfer/packages/{id}/new-source``). Both provision the same way — a usable
provider, a graph name nothing else owns, a data source, then its versioned graph — so the steps
live here, once: :func:`assert_provider_usable`, :func:`claim_graph_name`,
:func:`create_managed_data_source`, :func:`drop_managed_data_source` (the compensation when the
versioned graph can't be created) and :func:`register_aggregation`.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def graph_key_bindings(session: AsyncSession, provider_id: Optional[str], graph_name: str,
                             exclude_ds: Optional[str] = None) -> List[Dict[str, Optional[str]]]:
    """Every live binding of the key ``(provider_id, graph_name)``: data sources reading it (by
    ``graph_name``, or as their dedicated projection key) and catalog entries publishing it.

    EXACT match, unlike the blank-graph name check (:func:`_taken_graph_names`): that one asks
    "could a new name collide?" and so matches loosely; this one asks "who reads THIS key?", and a
    FalkorDB key is case-sensitive. A soft-deleted data source reads nothing and is not a binding.
    ``exclude_ds`` leaves out the asker's own data source.

    Each binding is ``{kind: 'dataSource', dataSourceId, workspaceId, name}`` or
    ``{kind: 'catalogItem', catalogItemId, name}``."""
    from backend.app.db.models import CatalogItemORM, WorkspaceDataSourceORM

    ds = WorkspaceDataSourceORM
    stmt = select(ds.id, ds.workspace_id, ds.label, ds.graph_name).where(
        ds.provider_id == provider_id, ds.deleted_at.is_(None),
        (ds.graph_name == graph_name) | (ds.dedicated_graph_name == graph_name),
    ).order_by(ds.id)
    if exclude_ds is not None:
        stmt = stmt.where(ds.id != exclude_ds)
    out: List[Dict[str, Optional[str]]] = [
        {"kind": "dataSource", "dataSourceId": ds_id, "workspaceId": ws_id,
         "name": label or name}
        for ds_id, ws_id, label, name in (await session.execute(stmt)).all()]
    cats = (await session.execute(select(CatalogItemORM.id, CatalogItemORM.name).where(
        CatalogItemORM.provider_id == provider_id,
        CatalogItemORM.source_identifier == graph_name,
    ).order_by(CatalogItemORM.id))).all()
    out.extend({"kind": "catalogItem", "catalogItemId": cat_id, "name": name}
               for cat_id, name in cats)
    return out


async def shared_with(session: AsyncSession, ds) -> Dict[str, object]:
    """The OTHER data sources bound to ``ds``'s physical graph — what a duplicate collapse in that
    graph changes besides ``ds`` — as the bootstrap status shows them: ``sharedWith`` names those
    in ``ds``'s own workspace (``[{dataSourceId, name}]``); those in other workspaces are only
    counted (``sharedWithOtherWorkspaces``). The status is readable by anyone who may read this
    workspace, and a workspace must never learn another's data sources — the rest of the API
    answers 404, not 403, for the same reason."""
    name = getattr(ds, "graph_name", None)
    mine: List[Dict[str, Optional[str]]] = []
    others = 0
    if name:
        for b in await graph_key_bindings(session, getattr(ds, "provider_id", None), name,
                                          exclude_ds=ds.id):
            if b["kind"] != "dataSource":
                continue
            if b["workspaceId"] == ds.workspace_id:
                mine.append({"dataSourceId": b["dataSourceId"], "name": b["name"]})
            else:
                others += 1
    return {"sharedWith": mine, "sharedWithOtherWorkspaces": others}


# ── Physical graph naming (managed sources) ──────────────────────────────────
# The graph name IS the FalkorDB key the model projects into, and a full
# projection seed WIPES that key — a collision is destructive. Names are
# therefore validated centrally: slug rules, reserved system prefixes, and
# per-provider uniqueness across ALL workspaces (the DB unique constraint is
# only per-workspace), plus a best-effort live GRAPH.LIST check.
_GRAPH_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")
_RESERVED_GRAPH_PREFIXES = ("gv_", "gvt_", "gvtest_", "blank_", "__fork_")


#: "data_lineage_2" -> ("data_lineage", 2). Lets a suggestion keep counting from an
#: already-numbered name instead of producing "data_lineage_2_2".
_NUMBERED_SUFFIX_RE = re.compile(r"^(?P<base>.+?)_(?P<n>\d+)$")
_MAX_GRAPH_NAME_LEN = 64


async def _taken_graph_names(
    session: AsyncSession, provider_id: str, base: str,
) -> set:
    """Every name on this connection that could collide with ``base`` or ``base_N``.

    Fetched in ONE pass so suggesting a free name doesn't re-run the whole
    availability check (and its live GRAPH.LIST) once per candidate.
    """
    from sqlalchemy import or_, select
    from backend.app.db.models import CatalogItemORM, WorkspaceDataSourceORM

    like = f"{base}%"
    taken: set = set()

    rows = (await session.execute(
        select(WorkspaceDataSourceORM.graph_name, WorkspaceDataSourceORM.dedicated_graph_name)
        .where(
            WorkspaceDataSourceORM.provider_id == provider_id,
            # A tombstone must not reserve its graph name forever. The live
            # GRAPH.LIST pass below still guards the destructive case: while the
            # deleted source's key physically exists, the name stays taken.
            WorkspaceDataSourceORM.deleted_at.is_(None),
            or_(WorkspaceDataSourceORM.graph_name.ilike(like),
                WorkspaceDataSourceORM.dedicated_graph_name.ilike(like)),
        ))).all()
    for graph_name, dedicated in rows:
        for value in (graph_name, dedicated):
            if value:
                taken.add(str(value).strip().lower())

    cats = (await session.execute(
        select(CatalogItemORM.source_identifier).where(
            CatalogItemORM.provider_id == provider_id,
            CatalogItemORM.source_identifier.ilike(like),
        ))).scalars().all()
    taken.update(str(c).strip().lower() for c in cats if c)

    from backend.app.providers.falkor_graph_registry import list_graph_keys
    keys = await list_graph_keys(provider_id)
    if keys:
        taken.update(
            k.strip().lower() for k in keys
            if k and k.strip().lower().startswith(base)
        )
    return taken


def _next_free_graph_name(base: str, taken: set) -> Optional[str]:
    """First free ``base_N`` (N >= 2). None when the family is exhausted."""
    trimmed = base[: _MAX_GRAPH_NAME_LEN - 5] or base  # leave room for "_999"
    for n in range(2, 1000):
        candidate = f"{trimmed}_{n}"
        if len(candidate) > _MAX_GRAPH_NAME_LEN:
            return None
        if candidate not in taken:
            return candidate
    return None


async def _suggest_graph_name(
    session: AsyncSession, provider_id: str, normalized: str,
) -> Optional[str]:
    match = _NUMBERED_SUFFIX_RE.match(normalized)
    base = match.group("base") if match else normalized
    taken = await _taken_graph_names(session, provider_id, base)
    return _next_free_graph_name(base, taken)


async def _graph_name_availability(
    session: AsyncSession, provider_id: str, raw: str, *, suggest: bool = False,
) -> Dict[str, object]:
    """``{available, normalized, reason?, suggestion?}`` for a proposed graph name.

    The graph name IS the FalkorDB key the model projects into, and a projection
    seed WIPES that key — so a collision is destructive and this must never say
    "available" for a name anything else already owns. When ``suggest`` is set, a
    taken name also comes back with the first free ``<base>_<n>`` so the caller can
    offer it instead of making the user invent one.
    """
    from sqlalchemy import or_, select
    from backend.app.db.models import CatalogItemORM, WorkspaceDataSourceORM

    normalized = (raw or "").strip().lower()
    if not _GRAPH_NAME_RE.match(normalized):
        return {"available": False, "normalized": normalized,
                "reason": "Use 3–64 characters: lowercase letters, numbers, '-' or '_', "
                          "starting with a letter or number."}
    if normalized.startswith(_RESERVED_GRAPH_PREFIXES) or normalized.endswith("_proj"):
        return {"available": False, "normalized": normalized,
                "reason": "Names starting with gv_, gvt_, blank_, __fork_ or ending in "
                          "_proj are reserved for the system."}

    async def _taken(reason: str) -> Dict[str, object]:
        out: Dict[str, object] = {"available": False, "normalized": normalized, "reason": reason}
        if suggest:
            out["suggestion"] = await _suggest_graph_name(session, provider_id, normalized)
        return out

    ds_taken = (await session.execute(
        select(WorkspaceDataSourceORM.id).where(
            WorkspaceDataSourceORM.provider_id == provider_id,
            WorkspaceDataSourceORM.deleted_at.is_(None),
            or_(WorkspaceDataSourceORM.graph_name == normalized,
                WorkspaceDataSourceORM.dedicated_graph_name == normalized),
        ).limit(1))).scalar_one_or_none()
    if ds_taken:
        return await _taken("Another data source on this connection already uses this name.")
    cat_taken = (await session.execute(
        select(CatalogItemORM.id).where(
            CatalogItemORM.provider_id == provider_id,
            CatalogItemORM.source_identifier == normalized,
        ).limit(1))).scalar_one_or_none()
    if cat_taken:
        return await _taken("A catalogued graph on this connection already uses this name.")
    # Live key check — best-effort (None = unreachable → registry checks stand alone;
    # they cover every app-managed key, so only out-of-band keys slip past).
    from backend.app.providers.falkor_graph_registry import list_graph_keys
    keys = await list_graph_keys(provider_id)
    if keys is not None and normalized in keys:
        return await _taken("A graph with this name already exists on this connection.")
    return {"available": True, "normalized": normalized}


# ── Provisioning ─────────────────────────────────────────────────────────────


async def assert_provider_usable(session: AsyncSession, ws_id: str, provider_id: str, *,
                                 subject: str = "Blank models"):
    """The provider a managed source is created on: it must exist, be active, be FalkorDB (Neo4j
    later), be permitted in ``ws_id`` and be REACHABLE. Returns its row; raises the HTTP answer
    otherwise (422 ``provider_unsupported`` / ``provider_unreachable``, 403). ``subject`` names
    what is being created, in the refusal of a non-FalkorDB provider."""
    from backend.app.db.repositories import provider_repo

    # 1) Provider must exist, be active, FalkorDB (Neo4j later), and workspace-permitted.
    prov = await provider_repo.get_provider_orm(session, provider_id)
    if prov is None or not prov.is_active:
        raise HTTPException(status_code=422, detail={
            "type": "provider_unsupported",
            "message": "The selected provider connection does not exist or is inactive."})
    if prov.provider_type != "falkordb":
        raise HTTPException(status_code=422, detail={
            "type": "provider_unsupported",
            "message": f"{subject} are FalkorDB-backed for now; '{prov.provider_type}' "
                       "providers are not supported yet."})
    try:
        permitted = json.loads(prov.permitted_workspaces or '["*"]')
    except Exception:
        permitted = ["*"]
    if "*" not in permitted and ws_id not in permitted:
        raise HTTPException(status_code=403, detail="provider not permitted in this workspace")

    # 1b) Provider must be REACHABLE, not merely enabled. A model is worthless if its
    #     backing store is down, and a full projection would fail — so refuse up front.
    #     First the cached breaker/warmup verdict (the SAME signal the UI's status dot
    #     shows, via resolve_provider_status — zero I/O); then, only when that signal is
    #     'unknown' (never warmed up), one bounded live probe so a genuinely-down but
    #     un-observed provider can't slip through.
    from backend.app.providers.manager import provider_manager as _provider_mgr
    from backend.app.providers.reachability import resolve_provider_status
    try:
        _breakers = _provider_mgr.report_provider_states()
    except Exception:
        _breakers = {}
    _warmup = getattr(_provider_mgr, "warmup_cache", {}) or {}
    _status, _status_err = resolve_provider_status(
        is_active=prov.is_active, provider_id=prov.id,
        breaker_states=_breakers, warmup_cache=_warmup)
    if _status == "unavailable":
        raise HTTPException(status_code=422, detail={
            "type": "provider_unreachable",
            "message": f"'{prov.name}' is currently offline ({_status_err or 'connection failed'}). "
                       "Reconnect it, then try again."})
    if _status == "unknown":
        # Never observed — probe live (bounded ~2.5s) rather than assume healthy.
        try:
            from backend.app.api.v1.endpoints.providers import _run_connectivity_probe
            _creds = await provider_repo.get_credentials(session, prov.id)
            try:
                _extra = json.loads(prov.extra_config) if prov.extra_config else None
            except (ValueError, TypeError):
                _extra = None
            _probe = await _run_connectivity_probe(
                provider_type=prov.provider_type, host=prov.host, port=prov.port,
                tls_enabled=prov.tls_enabled, creds=_creds, extra_config=_extra)
            if not _probe.success:
                raise HTTPException(status_code=422, detail={
                    "type": "provider_unreachable",
                    "message": f"'{prov.name}' could not be reached ({_probe.error or 'connection failed'}). "
                               "Check the connection, then try again."})
        except HTTPException:
            raise
        except Exception:
            # Probe machinery unavailable (e.g. import/config issue) — don't hard-fail
            # provisioning on a maybe-healthy provider; the cached gate already caught
            # confirmed-down providers, and the first projection surfaces real errors.
            logger.exception("blank-graph live reachability probe errored for %s", prov.id)
    return prov


async def claim_graph_name(session: AsyncSession, provider_id: str, graph_name: str) -> str:
    """The user's choice of physical graph name, validated and normalized — serialized under a
    per-(provider, name) advisory lock held to the end of ``session``'s transaction, so two
    concurrent provisions can't race past the cross-workspace uniqueness check the DB constraint
    doesn't cover. Commit the data source in the same transaction. 422 ``graph_name_unavailable``
    (with a free ``suggestion``) when it is taken or not a valid name."""
    from sqlalchemy import text as _sql_text
    await session.execute(_sql_text(
        "SELECT pg_advisory_xact_lock(hashtext(:k))"
    ), {"k": f"graph-name:{provider_id}:{graph_name.strip().lower()}"})
    verdict = await _graph_name_availability(
        session, provider_id, graph_name, suggest=True)
    if not verdict["available"]:
        # Someone took the name while this wizard was open. Hand back a free one
        # so the client can offer a single-click fix instead of a retry that can
        # only ever fail again. NEVER fall through to the existing graph: a
        # projection seed would wipe whatever lives under that key.
        raise HTTPException(status_code=422, detail={
            "type": "graph_name_unavailable",
            "message": verdict["reason"],
            "suggestion": verdict.get("suggestion"),
        })
    return str(verdict["normalized"])


async def create_managed_data_source(
    session: AsyncSession, ws_id: str, *, provider_id: str, ontology_id: Optional[str],
    label: str, actor: str, graph_name: Optional[str] = None,
    origin: Optional[Dict[str, Any]] = None,
) -> Tuple[str, str]:
    """A manual, managed data source on ``provider_id`` — no catalog item, ``ontology_id`` bound —
    committed. Its physical graph is ``graph_name`` (claimed by :func:`claim_graph_name`), else a
    collision-proof ``blank_<ds_id>`` (a full projection seed wipes its named graph, so a minted
    key is never user-supplied). ``origin`` is recorded as ``extra_config.origin`` (what the source
    was made from). Returns ``(data_source_id, graph_name)``."""
    from backend.app.db.repositories import data_source_repo
    from backend.common.models.management import DataSourceCreateRequest

    ds = await data_source_repo.create_data_source(session, ws_id, DataSourceCreateRequest(
        provider_id=provider_id, ontology_id=ontology_id,
        label=label, access_level="write"))
    row = await data_source_repo.get_data_source_orm(session, ds.id)
    graph_name = graph_name or f"blank_{row.id}"
    row.graph_name = graph_name
    row.source_mode = "managed"
    row.created_by = actor
    if origin is not None:
        row.extra_config = json.dumps({"origin": origin})
    await session.commit()
    return ds.id, graph_name


async def drop_managed_data_source(session: AsyncSession, ds_id: str) -> bool:
    """Remove a managed data source whose versioned graph could not be created (or was given up
    before it went live). Never raises: a failure leaves an orphan data source, logged (the reaper
    removes a package's after an hour), and answers False."""
    from backend.app.db.repositories import data_source_repo

    try:
        await data_source_repo.delete_data_source(session, ds_id)
        await session.commit()
        return True
    except Exception:                                # pragma: no cover - double fault
        logger.exception("compensating delete of ds=%s failed — orphan data source", ds_id)
        return False


async def register_aggregation(session: AsyncSession, ds_id: str, idempotency_key: str) -> None:
    """Aggregation registration (best-effort, never fails provisioning): creates the data source's
    aggregation state row so readiness reads "configured" instead of "none", and wires the
    publish→rollup pipeline from day one. The projector's on_rollups_stale hook self-heals later if
    this is skipped."""
    try:
        from backend.app.main import app as _app
        agg = getattr(_app.state, "aggregation_service", None)
        if agg is not None:
            from backend.app.services.aggregation.schemas import AggregationTriggerRequest
            await agg.trigger(
                ds_id,
                AggregationTriggerRequest(idempotency_key=idempotency_key),
                "onboarding", session)
    except Exception as exc:
        logger.info("blank-model aggregation registration skipped for ds=%s: %s", ds_id, exc)


# ── Sources made from a view package ─────────────────────────────────────────


def origin_of(extra_config: Optional[str]) -> Optional[Dict[str, Any]]:
    """``origin`` of a data source's ``extra_config`` (JSON text) — what it was made from — or
    None."""
    try:
        origin = (json.loads(extra_config) if extra_config else {}).get("origin")
    except (ValueError, TypeError, AttributeError):
        return None
    return origin if isinstance(origin, dict) else None


async def find_origin_data_source(session: AsyncSession, ws_id: str, upload_id: str):
    """The live data source in ``ws_id`` that the package upload ``upload_id`` created, if one was
    (``extra_config.origin = {kind: 'viewPackage', uploadId}``) — so a retry of "new source from
    this package" reuses it instead of making a second. ``extra_config`` is JSON in a text column:
    narrowed by the id in SQL, confirmed by parsing."""
    from backend.app.db.models import WorkspaceDataSourceORM

    ds = WorkspaceDataSourceORM
    rows = (await session.execute(select(ds).where(
        ds.workspace_id == ws_id, ds.deleted_at.is_(None),
        ds.extra_config.contains(upload_id, autoescape=True),
    ).order_by(ds.created_at))).scalars().all()
    for row in rows:
        origin = origin_of(row.extra_config) or {}
        if origin.get("kind") == "viewPackage" and origin.get("uploadId") == upload_id:
            return row
    return None


def ontology_coverage(types: Optional[Dict[str, Any]], ontology) -> Dict[str, Any]:
    """How much of a graph's types an ontology declares — the ``/ontologies/suggest`` score, for
    one ontology. ``types`` is provider-stats shaped (``entityTypeCounts``, ``edgeTypeCounts``: a
    package's ``data.typeStats``); ``ontology`` has ``entity_type_definitions`` and
    ``relationship_type_definitions`` (dicts). The platform's built-in types count as declared, so
    ``AGGREGATED`` never reads as missing; relationship types compare upper-cased."""
    from backend.app.ontology.defaults import with_system_edge_types, with_system_entity_types

    entity_ids = set(_type_names((types or {}).get("entityTypeCounts")))
    rel_ids = {t.upper() for t in _type_names((types or {}).get("edgeTypeCounts"))}
    ont_entity_ids = set(with_system_entity_types(
        getattr(ontology, "entity_type_definitions", None) or {}).keys())
    ont_rel_ids = set(with_system_edge_types(
        getattr(ontology, "relationship_type_definitions", None) or {}).keys())
    graph_types, ont_types = entity_ids | rel_ids, ont_entity_ids | ont_rel_ids
    union = graph_types | ont_types
    return {
        "jaccardScore": round(len(graph_types & ont_types) / len(union), 3) if union else 0.0,
        "coveredEntityTypes": sorted(entity_ids & ont_entity_ids),
        "uncoveredEntityTypes": sorted(entity_ids - ont_entity_ids),
        "coveredRelationshipTypes": sorted(rel_ids & ont_rel_ids),
        "uncoveredRelationshipTypes": sorted(rel_ids - ont_rel_ids),
    }


def _type_names(counts: Optional[Iterable]) -> List[str]:
    return [str(t) for t in (counts or []) if t]
