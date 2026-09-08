"""Find — and, on an explicit instruction, drop — empty graphs nothing owns.

Background index DDL used to resurrect any graph an operator deleted out of
band: FalkorDB has no ``CREATE GRAPH``, so ``CREATE INDEX`` on a missing key
minted it with zero nodes and zero edges. That is fixed at the source (see
``FalkorDBProvider._graph_key_exists``), but the phantoms it already created
are still resident, and only an operator can say which of them were wanted.

The house rule this module obeys, from ``versioning/models.py`` and the
reference implementation in ``purge_worker._phase_falkor``: **a graph we cannot
prove is unreferenced is a graph we will not delete.** The costs are not
symmetric — refusing to drop leaks a graph, dropping wrongly destroys a
customer's data — so every uncertainty resolves to "protected", and every
candidate carries a verdict saying which rule applied.

Two consequences worth stating outright:

* **A reference lookup that fails aborts the scan.** ``_detect_registry_drift``
  degrades to ``None`` on a bad graphver read because a missing drift banner is
  survivable; here, degrading to "we saw no references" would erase graphs. So
  the failure propagates and the caller answers 503.
* **Names are matched globally, not per provider.** A graph named in the
  catalogue under a different provider still protects a key of that name here.
  A false protection leaks a graph; a false deletion does not come back.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import asdict, dataclass
from typing import Dict, List, Optional, Sequence

from sqlalchemy import select

logger = logging.getLogger(__name__)

#: Emptiness is established with a READ-ONLY query so the check itself can never
#: create the graph it is asking about — the exact failure mode this module
#: exists to clean up after.
_EMPTY_PROBE = "MATCH (n) RETURN 1 LIMIT 1"

#: An edge cannot exist without endpoints, so "no nodes" settles both. ``LIMIT
#: 1`` makes it an existence check rather than the full scan ``count(n)`` would
#: be — this runs over every unreferenced key on the instance.
_PROBE_TIMEOUT_S = float(os.getenv("ORPHAN_PROBE_TIMEOUT_SECS", "10"))


@dataclass
class OrphanCandidate:
    """One graph key on the instance, and what may be done with it."""

    name: str
    #: ``True``/``False`` once established; ``None`` when it could not be, which
    #: is always a reason to protect rather than to guess.
    empty: Optional[bool]
    #: Which reference sets name this key. Empty means nothing in the platform
    #: refers to it.
    referenced_by: List[str]
    deletable: bool
    verdict: str

    def to_dict(self) -> dict:
        return asdict(self)


async def _referenced_names(provider_id: str) -> Dict[str, List[str]]:
    """Every graph name the platform refers to, and what refers to it.

    Exactly what the tables say — the caller expands derived names.

    Reads the management DB and the versioning store — the latter behind its own
    engine, never joined into a management-pool query (same discipline as
    ``discovery._detect_registry_drift``). Neither read is best-effort: an
    exception propagates, because a reference set we could not load is
    indistinguishable from an empty one at the point where it matters.
    """
    from backend.app.db.engine import get_readonly_session
    from backend.app.db.models import CatalogItemORM, WorkspaceDataSourceORM

    referenced: Dict[str, List[str]] = {}

    def _note(name: Optional[str], why: str) -> None:
        if not name:
            return
        reasons = referenced.setdefault(name, [])
        if why not in reasons:
            reasons.append(why)

    async with get_readonly_session() as session:
        # Archived and deprecated catalogue items are INCLUDED on purpose: a
        # deactivated item still names a graph someone intends to bring back.
        for (name,) in (await session.execute(
            select(CatalogItemORM.source_identifier)
            .where(CatalogItemORM.source_identifier.is_not(None))
        )).all():
            _note(name, "catalog_item")

        for name, dedicated in (await session.execute(
            select(WorkspaceDataSourceORM.graph_name,
                   WorkspaceDataSourceORM.dedicated_graph_name)
        )).all():
            _note(name, "data_source")
            _note(dedicated, "data_source_dedicated")

    from backend.app.services.versioning.db import (
        get_session_factory as _graphver_session_factory,
    )
    from backend.app.services.versioning.models import ProjectionStateORM

    async with _graphver_session_factory()() as vsession:
        # EVERY status, including ``evicted``: the versioning cache manager
        # drops cold graphs by design and rebuilds them, so an evicted row is a
        # name that is coming back, not one that is free.
        for (name,) in (await vsession.execute(
            select(ProjectionStateORM.falkor_graph_name)
            .where(ProjectionStateORM.falkor_graph_name.is_not(None))
        )).all():
            _note(name, "projection_state")

    logger.debug(
        "orphan scan: %d referenced graph name(s) for provider %s",
        len(referenced), provider_id,
    )
    return referenced


async def _is_empty(cfg, name: str) -> Optional[bool]:
    """Whether ``name`` holds no nodes. ``None`` when that could not be settled."""
    from backend.app.providers.falkordb_connection import graph_clients
    from backend.app.providers.falkordb_provider import _is_missing_graph_error

    try:
        graph = await graph_clients().get_graph(cfg, name)
        result = await asyncio.wait_for(
            graph.ro_query(_EMPTY_PROBE), timeout=_PROBE_TIMEOUT_S,
        )
        return not (result.result_set or [])
    except Exception as exc:
        if _is_missing_graph_error(exc):
            # Vanished between GRAPH.LIST and the probe. Nothing to drop.
            return None
        logger.warning(
            "orphan scan: could not verify whether %r is empty: %s", name, exc,
        )
        return None


async def scan_orphan_graphs(provider_id: str) -> List[OrphanCandidate]:
    """Every graph key on ``provider_id``'s instance, with a verdict each.

    Referenced keys are returned too, marked protected. The preview's value is
    saying what will NOT be touched and why — a list of only the deletable ones
    asks an operator to trust a filter they cannot see.

    Raises ``ProviderConfigurationError`` for a provider that is missing,
    inactive, non-FalkorDB or has no host (``resolve_provider_conn_config``
    refuses to fall back to the env instance, and defeating that here would
    scan the wrong machine).
    """
    from backend.app.providers.falkor_graph_registry import (
        resolve_provider_conn_config,
    )
    from backend.app.providers.falkordb_connection import list_graph_keys_for_config

    cfg = await resolve_provider_conn_config(provider_id)
    # Topology-aware: on a cluster this unions GRAPH.LIST over every primary. A
    # single-node listing under-reports, and an under-reported listing here is
    # only ever a missing candidate, never a wrong deletion.
    keys = sorted(await list_graph_keys_for_config(cfg))
    referenced = await _referenced_names(provider_id)
    # A dedicated projection lives at ``{graph}_proj`` and is named by no table
    # — it is derived from its source's name. Expanded here rather than inside
    # ``_referenced_names`` because that function reports what the tables SAY;
    # this is scan policy about what those statements imply.
    for name in list(referenced):
        referenced.setdefault(f"{name}_proj", []).append("derived_projection")

    candidates: List[OrphanCandidate] = []
    for name in keys:
        reasons = referenced.get(name, [])
        if reasons:
            # Referenced keys are never probed: they are the big ones, and there
            # is no answer the probe could give that would change the verdict.
            candidates.append(OrphanCandidate(
                name=name, empty=None, referenced_by=reasons, deletable=False,
                verdict=(
                    f"PROTECTED: referenced by {', '.join(reasons)} — names are "
                    f"matched across every provider on purpose"
                ),
            ))
            continue

        empty = await _is_empty(cfg, name)
        if empty is None:
            candidates.append(OrphanCandidate(
                name=name, empty=None, referenced_by=[], deletable=False,
                verdict="PROTECTED: could not verify that it is empty",
            ))
        elif not empty:
            candidates.append(OrphanCandidate(
                name=name, empty=False, referenced_by=[], deletable=False,
                verdict=(
                    "PROTECTED: holds data. Nothing in the platform refers to "
                    "it, but that makes it unregistered, not disposable"
                ),
            ))
        else:
            candidates.append(OrphanCandidate(
                name=name, empty=True, referenced_by=[], deletable=True,
                verdict="orphan: empty, and nothing in the platform refers to it",
            ))
    return candidates


async def delete_orphan_graphs(
    provider_id: str, names: Sequence[str], *, dry_run: bool = True,
) -> List[OrphanCandidate]:
    """Drop the named graphs, if they are still orphans.

    The scan is re-run rather than trusting the preview the caller saw: a graph
    can be registered, or filled, between looking and deciding. A name the
    caller asked for that is no longer deletable comes back with its protection
    verdict and is left alone — one refusal never aborts the rest.
    """
    from backend.app.providers.falkor_graph_registry import (
        resolve_provider_conn_config,
    )
    from backend.app.providers.falkordb_connection import graph_clients

    wanted = set(names)
    fresh = {c.name: c for c in await scan_orphan_graphs(provider_id)}
    cfg = await resolve_provider_conn_config(provider_id)

    results: List[OrphanCandidate] = []
    for name in names:
        candidate = fresh.get(name)
        if candidate is None:
            results.append(OrphanCandidate(
                name=name, empty=None, referenced_by=[], deletable=False,
                verdict="skipped: no longer present on this instance",
            ))
            continue
        if not candidate.deletable:
            results.append(candidate)
            continue
        if dry_run:
            results.append(OrphanCandidate(
                name=name, empty=True, referenced_by=[], deletable=True,
                verdict="would drop (dry run — nothing was deleted)",
            ))
            continue
        try:
            graph = await graph_clients().get_graph(cfg, name)
            # Reachability probe before a destructive call, the same order
            # ``projection.py``'s non-destructive rebuild uses: a drop issued
            # into a broken connection is the one failure worth ruling out
            # first.
            await asyncio.wait_for(
                graph.ro_query("RETURN 1"), timeout=_PROBE_TIMEOUT_S,
            )
            await graph.delete()
        except Exception as exc:
            logger.warning("orphan cleanup: dropping %r failed: %s", name, exc)
            results.append(OrphanCandidate(
                name=name, empty=True, referenced_by=[], deletable=True,
                verdict=f"FAILED: {type(exc).__name__}: {exc}",
            ))
            continue
        logger.warning(
            "orphan cleanup: DROPPED empty unreferenced graph %r on provider %s",
            name, provider_id,
        )
        results.append(OrphanCandidate(
            name=name, empty=True, referenced_by=[], deletable=True,
            verdict="dropped",
        ))

    unknown = wanted - set(fresh)
    if unknown:
        logger.info(
            "orphan cleanup: %d requested name(s) are not on this instance: %s",
            len(unknown), ", ".join(sorted(unknown)[:5]),
        )
    return results
