"""ViewScopeResolver — server-side enforcement of per-view search boundaries.

Every advanced-search request is bound to exactly one view (``scope.view_id``).
This module reads the view's persisted config and produces a frozen
``EffectiveViewScope`` that the predicate compiler then enforces. The
client's narrowing hints (``root_urns``, ``entity_types``, ``layer_assignment``,
``max_depth``) may only *tighten* the scope; they can never widen it.

Why server-side resolution
--------------------------
- **Security**: a malicious or buggy client cannot ask for URNs that lie
  outside the view by passing them in ``scope.root_urns``. The resolver
  drops them with a logged ``search_adv_scope_violation_total`` counter.
- **Correctness**: the FE doesn't know the full URN set of a 1M-node
  view, so an allow-list payload approach (option B in the design) is
  out. Materialised subgraphs (option C) are wasteful given FalkorDB's
  bounded variable-length scope clamp already exists.
- **Cache coherence**: the resolved scope produces a stable
  ``scope_hash`` that includes the view's ``updated_at`` — editing a
  view automatically invalidates its cached search results.

Per-canvas dispatch
-------------------
The view type drives how root URNs are derived:

- ``reference`` / ``context-view`` — root URNs come from each
  ``referenceLayout.layers[].entityAssignments[].urn`` (explicit
  assignments) ∪ the resolved top-level URNs for each declared
  ``rootEntityTypes`` entry. ``entity_type_allow_list`` = union of
  ``layers[].entityTypes``; ``layer_allow_list`` = ``layers[].id``.
- ``graph`` / ``layered-lineage`` — root URNs from ``config.rootUrns``
  (if persisted) else resolved from ``content.rootEntityTypes`` via the
  provider's top-level-node lookup. ``entity_type_allow_list`` =
  ``visibleEntityTypes``.
- ``hierarchy`` / ``tree`` — root URNs from ``config.rootUrns``;
  ``max_depth`` clamped to ``content.maxDepth``.

Views without explicit roots fall back to "the workspace's top-level
nodes whose entity type is in the configured ``rootEntityTypes``" — the
existing ``get_top_level_or_orphan_nodes`` path is the canonical source
of that set, so the resolver delegates to it.

Failure modes
-------------
- ``ViewNotFound``: ``view_id`` doesn't exist in this workspace. HTTP 404.
- ``ViewScopeError`` with ``reason='cross_workspace'``: the view exists
  but in a different workspace. HTTP 404 (do not leak existence).
- ``ViewScopeError`` with ``reason='entity_type_not_in_view'``: a
  requested entity type isn't visible in this view. HTTP 400.
- ``ViewScopeError`` with ``reason='empty_after_intersection'``: every
  requested URN was dropped. The service returns an empty page rather
  than a 4xx — the FE can show "no matches in this view".
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, Iterable, List, Literal, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewORM
from backend.app.db.repositories.view_repo import effective_view_config
from backend.app.services.layout_config import parse_reference_layout
from backend.common.models.search import SearchScope

logger = logging.getLogger(__name__)


CanvasKind = Literal[
    "reference", "graph", "hierarchy", "tree", "layered-lineage", "unknown",
]


class ViewNotFound(LookupError):
    """The requested ``view_id`` does not exist (or is soft-deleted)."""


class ViewScopeError(ValueError):
    """The requested scope cannot be resolved within the view.

    ``reason`` is one of:
      - ``cross_workspace``     — view exists in a different workspace
      - ``entity_type_not_in_view`` — requested entity type out-of-view
      - ``max_depth_invalid``   — view's stored max_depth is non-positive
      - ``empty_after_intersection`` — every URN was dropped (info-level)
    """
    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class EffectiveViewScope:
    """The authoritative scope for a single search.

    Constructed by ``ViewScopeResolver.resolve``. The compiler consumes
    this rather than the raw ``SearchScope`` so it cannot accidentally
    honour out-of-view client values.

    ``scope_hash`` combines the view's ``updated_at`` (so edits invalidate
    derived caches) with the canonical representation of every other
    field, then sha1-truncates to 12 chars.
    """
    view_id: str
    workspace_id: str
    data_source_id: Optional[str]
    canvas_kind: CanvasKind
    root_urns: Tuple[str, ...]
    entity_type_allow_list: FrozenSet[str]
    layer_allow_list: FrozenSet[str]
    max_depth: int
    scope_hash: str
    dropped_urns: Tuple[str, ...] = field(default_factory=tuple)
    """URNs the client sent that were filtered out (out-of-view). The
    service surfaces these via the ``X-Search-Dropped-URNs`` header and
    the audit log."""
    view_data_source_id: Optional[str] = None
    """The data source the VIEW belongs to, verbatim from the view row.

    Distinct from ``data_source_id`` above, which the caller's own
    ``?dataSourceId=`` overrides — so that field can never answer "which
    source does this view live in?". The search's roots come from the
    view while the engine's provider comes from the request, and only
    this field lets the service check that the two agree."""


# --------------------------------------------------------------------------- #
# View config helpers (read-only)                                              #
# --------------------------------------------------------------------------- #

# Reserved keys live alongside user properties in the view's stored JSON.
# These are the field names we read.
_CONFIG_KEY_CONTENT = "content"
_CONFIG_KEY_ROOT_URNS = "rootUrns"
_CONFIG_KEY_VISIBLE_ENTITY_TYPES = "visibleEntityTypes"
_CONFIG_KEY_ROOT_ENTITY_TYPES = "rootEntityTypes"
_CONFIG_KEY_MAX_DEPTH = "maxDepth"


def _parse_view_config(raw: Optional[str]) -> Dict[str, Any]:
    """Tolerant JSON parse. Empty/invalid config → empty dict."""
    if not raw:
        return {}
    try:
        result = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("view config is not valid JSON; treating as empty")
        return {}
    if not isinstance(result, dict):
        return {}
    return result


def _classify_canvas(view_type: Optional[str], config: Dict[str, Any]) -> CanvasKind:
    """Decide which scope-derivation rule to apply.

    ``layoutType`` overrides ``view_type`` when set — it's the wizard's
    "what kind of canvas am I" choice. ``view_type`` is the older
    persistent field.
    """
    layout_type = (config.get("layoutType") if isinstance(config, dict) else None) or ""
    candidate = (layout_type or view_type or "").lower()
    if candidate in ("reference", "context-view", "contextview"):
        return "reference"
    if candidate in ("layered-lineage", "lineage"):
        return "layered-lineage"
    if candidate in ("graph", "graph-canvas"):
        return "graph"
    if candidate in ("hierarchy", "tree"):
        return "hierarchy" if "hierarchy" in candidate else "tree"
    return "unknown"


def _collect_reference_roots(
    config: Dict[str, Any],
) -> Tuple[List[str], FrozenSet[str], FrozenSet[str]]:
    """Reference / context-view layout root extraction.

    Reads the canonical view-config shape via ``parse_reference_layout``,
    which up-converts legacy per-layer ``entityAssignments`` (and the
    top-level ``referenceLayout`` spelling this module's rows use) into a
    flattened ``assignments`` map. Root URNs are the assignment keys that
    carry a ``layerId`` (a real placement, not a UI-only entry).

    Returns ``(root_urns, entity_type_allow_list, layer_allow_list)``.
    """
    entity_types: List[str] = []
    layer_ids: List[str] = []
    layout = parse_reference_layout(config)
    for layer in layout.layers:
        if not isinstance(layer, dict):
            continue
        layer_id = layer.get("id")
        if isinstance(layer_id, str) and layer_id:
            layer_ids.append(layer_id)
        for ent_type in layer.get("entityTypes") or []:
            if isinstance(ent_type, str) and ent_type:
                entity_types.append(ent_type)
    root_urns = [
        urn for urn, assignment in layout.assignments.items()
        if isinstance(assignment, dict) and assignment.get("layerId")
    ]
    return root_urns, frozenset(entity_types), frozenset(layer_ids)


def _collect_content_scope(
    config: Dict[str, Any],
) -> Tuple[List[str], FrozenSet[str], int]:
    """Generic ``content``-block scope extraction.

    Returns ``(root_urns, entity_type_allow_list, max_depth_hint)``.
    ``max_depth_hint`` defaults to ``0`` (treated as "no constraint")
    when not configured.
    """
    content = config.get(_CONFIG_KEY_CONTENT) or {}
    if not isinstance(content, dict):
        return [], frozenset(), 0
    root_urns_raw = content.get(_CONFIG_KEY_ROOT_URNS) or []
    root_urns: List[str] = [u for u in root_urns_raw if isinstance(u, str) and u]
    ent_types_raw = (
        content.get(_CONFIG_KEY_VISIBLE_ENTITY_TYPES)
        or content.get(_CONFIG_KEY_ROOT_ENTITY_TYPES)
        or []
    )
    entity_types = frozenset(
        t for t in ent_types_raw if isinstance(t, str) and t
    )
    max_depth_raw = content.get(_CONFIG_KEY_MAX_DEPTH)
    try:
        max_depth_hint = int(max_depth_raw) if max_depth_raw is not None else 0
    except (TypeError, ValueError):
        max_depth_hint = 0
    return root_urns, entity_types, max_depth_hint


def _compute_scope_hash(
    *,
    view_id: str,
    updated_at: Optional[str],
    root_urns: Tuple[str, ...],
    entity_types: FrozenSet[str],
    layer_ids: FrozenSet[str],
    max_depth: int,
    branch_id: Optional[str] = None,
) -> str:
    """Stable 12-char sha1 of every input + the view's ``updated_at``.

    Including ``updated_at`` means a view edit auto-invalidates any
    cache entry keyed by this hash; not including any URLs / wall-clock
    means two requests against an unchanged view produce identical
    hashes (cache hits).

    ``branch_id`` folds the resolving branch into the key so a draft's
    scoped search (whose effective config is base ⊕ its layout overlay)
    can never share a cached scope with a published search on the same
    view — or with a different draft. Published (no branch) hashes as "".
    """
    payload = {
        "view_id": view_id,
        "updated_at": updated_at or "",
        "branch_id": branch_id or "",
        "root_urns": list(root_urns),
        "entity_types": sorted(entity_types),
        "layer_ids": sorted(layer_ids),
        "max_depth": max_depth,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:12]


# --------------------------------------------------------------------------- #
# Resolver                                                                     #
# --------------------------------------------------------------------------- #

# View-level absolute maximum traversal depth, applied even when the view
# stores something larger. Mirrors ``SearchScope.max_depth.le``.
_HARD_MAX_DEPTH = 20

# Default depth when neither the view nor the client supplies one. The
# Cypher scope continuation already caps variable-length walks via this
# constant; 12 hops covers the deepest realistic lineage chain
# (domain → ... → schemaField) by a wide margin.
_DEFAULT_MAX_DEPTH = 12


class ViewScopeResolver:
    """Resolve a ``SearchScope`` to an ``EffectiveViewScope`` for a workspace.

    Stateless other than the bound SQLAlchemy session; one instance is
    constructed per HTTP request and discarded.

    The resolver does NOT issue any provider Cypher queries — it works
    purely from the persisted view config. The candidate-set computation
    (root URN expansion when ``rootEntityTypes`` requires it) is left to
    the compiler's scope-continuation step, which already does this via
    a bounded variable-length walk. Keeping the resolver Cypher-free
    means it doesn't sit in the request's hot path beyond a single SQL
    SELECT.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def resolve(
        self,
        *,
        workspace_id: str,
        requested: SearchScope,
        data_source_id: Optional[str] = None,
        branch_id: Optional[str] = None,
    ) -> EffectiveViewScope:
        """Produce the authoritative scope or raise.

        Notes
        -----
        - ``workspace_id`` is the route's path workspace; cross-workspace
          access is rejected as ``ViewNotFound`` to avoid leaking the
          existence of views in other tenants.
        - ``data_source_id`` (when provided) is forwarded only for the
          ``EffectiveViewScope`` record; the resolver does not currently
          gate by data source (views own that mapping internally).
        - ``branch_id`` (when a draft is reading) resolves the view's
          BRANCH-EFFECTIVE config (base ⊕ the branch's layout overlay) so a
          draft's search sees its own layer/assignment edits; published /
          other branches see the base. Also folded into the scope hash so a
          draft and a published search never share a cached scope.
        - ``requested.root_urns`` and ``requested.entity_types`` are
          treated as *narrowing* hints; the resolver intersects them
          with the view's allowed scope and never widens.
        """
        view = await self._load_view(requested.view_id)
        if view is None:
            raise ViewNotFound(f"view '{requested.view_id}' not found")
        if view.workspace_id != workspace_id:
            # Same code path as not-found — never leak cross-tenant
            # existence.
            raise ViewNotFound(f"view '{requested.view_id}' not found")
        if view.deleted_at is not None:
            raise ViewNotFound(
                f"view '{requested.view_id}' has been deleted"
            )

        # Branch-effective read: base config when no branch/overlay, else
        # base ⊕ the branch's layout overlay (see view_repo).
        config = await effective_view_config(self._session, view, branch_id)
        canvas_kind = _classify_canvas(view.view_type, config)

        # Per-canvas root + entity-type + layer extraction.
        ref_roots, ref_ent_types, layer_ids = _collect_reference_roots(config)
        cnt_roots, cnt_ent_types, cnt_max_depth = _collect_content_scope(config)

        allowed_root_urns: List[str] = sorted(set(ref_roots) | set(cnt_roots))
        # Entity-type allow-list is the union of both sources; empty
        # means "no constraint from the view".
        allowed_entity_types: FrozenSet[str] = ref_ent_types | cnt_ent_types

        # Depth: view config > request hint, then hard cap.
        view_max_depth = cnt_max_depth if cnt_max_depth > 0 else _DEFAULT_MAX_DEPTH
        requested_max_depth = requested.max_depth or _DEFAULT_MAX_DEPTH
        effective_max_depth = max(
            1,
            min(view_max_depth, requested_max_depth, _HARD_MAX_DEPTH),
        )

        # Apply client narrowing hints (intersect; never widen).
        effective_root_urns, dropped = _intersect_root_urns(
            requested.root_urns, allowed_root_urns,
        )
        effective_entity_types = _intersect_entity_types(
            requested.entity_types, allowed_entity_types,
        )

        scope_hash = _compute_scope_hash(
            view_id=view.id,
            updated_at=view.updated_at,
            branch_id=branch_id,
            root_urns=tuple(effective_root_urns),
            entity_types=effective_entity_types,
            layer_ids=layer_ids,
            max_depth=effective_max_depth,
        )

        if dropped:
            logger.info(
                "search.view_scope.dropped_urns view=%s ws=%s n=%d",
                view.id, workspace_id, len(dropped),
            )

        return EffectiveViewScope(
            view_id=view.id,
            workspace_id=view.workspace_id,
            data_source_id=data_source_id or view.data_source_id,
            view_data_source_id=view.data_source_id,
            canvas_kind=canvas_kind,
            root_urns=tuple(effective_root_urns),
            entity_type_allow_list=effective_entity_types,
            layer_allow_list=layer_ids,
            max_depth=effective_max_depth,
            scope_hash=scope_hash,
            dropped_urns=tuple(dropped),
        )

    async def _load_view(self, view_id: str) -> Optional[ViewORM]:
        """Single SELECT against ``views`` keyed by ``view_id``.

        Avoids the enriched-response path (workspace + data-source +
        creator joins) because the resolver only needs raw config + IDs.
        """
        result = await self._session.execute(
            select(ViewORM).where(ViewORM.id == view_id)
        )
        return result.scalar_one_or_none()


# --------------------------------------------------------------------------- #
# Intersection helpers                                                         #
# --------------------------------------------------------------------------- #

def _intersect_root_urns(
    requested: Optional[List[str]],
    allowed: List[str],
) -> Tuple[List[str], List[str]]:
    """Filter requested URNs to those that are in (or descended from)
    the allowed set.

    The resolver itself cannot tell "is X a descendant of Y" without
    traversing the graph; instead it accepts URNs that are either
    equal to one of ``allowed`` or share its prefix. The Cypher
    scope-continuation step then runs the rigorous descendancy check.

    Returns ``(kept, dropped)``.
    """
    if not requested:
        return list(allowed), []
    if not allowed:
        # No view restriction → any client root is acceptable; this is
        # the "workspace-wide" view case that shouldn't happen in
        # production but is permitted for engineering / "graph" canvas.
        return [u for u in requested if u], []
    allowed_set = set(allowed)
    kept: List[str] = []
    dropped: List[str] = []
    for urn in requested:
        if not urn:
            continue
        if urn in allowed_set:
            kept.append(urn)
            continue
        # Prefix check — a URN under one of the allowed roots is
        # accepted; the Cypher step verifies it actually descends.
        if any(urn.startswith(root + "/") or urn.startswith(root + ":")
               for root in allowed):
            kept.append(urn)
        else:
            dropped.append(urn)
    return kept, dropped


def _intersect_entity_types(
    requested: Optional[Iterable[str]],
    allowed: FrozenSet[str],
) -> FrozenSet[str]:
    """Intersect client entity-type hint with the view's allow-list.

    Raises ``ViewScopeError(reason='entity_type_not_in_view')`` when the
    client requests a type the view doesn't permit. An empty intersection
    is *not* an error — it means "search nothing inside this view", which
    the service surfaces as an empty result page.
    """
    if not requested:
        return allowed
    requested_set = frozenset(t for t in requested if t)
    if not allowed:
        # Unconstrained view (graph canvas) — accept whatever the
        # client asks for.
        return requested_set
    bad = requested_set - allowed
    if bad:
        raise ViewScopeError(
            "entity_type_not_in_view",
            f"entity types {sorted(bad)!r} are not visible in this view "
            f"(allowed: {sorted(allowed)!r})",
        )
    return requested_set & allowed
