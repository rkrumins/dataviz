"""Semantic layers in the Playground: which ones a member may build on, and their own.

A member builds on an approved org-wide layer (published, ``scope="universal"``, not a system
layer), a starter, a sample's, one of their own, or one another member shared with the Playground.
Their own layers are owned by the Playground (``owner_workspace_id``) and made by them
(``created_by``): they edit and publish those whatever the org's semantic-layer switches say.

The contract the rest of the Playground builds on (``scratchpad/byod-layers/CONTRACT.md``):
:func:`offered_ontology_ids`, :func:`assert_offered`, :func:`starter_types_of`,
:func:`create_owned` and :func:`drop_owned`.
"""
from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Sequence, Set, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import OntologyORM
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.playground_starter import EntityType, RelationshipType


async def offered_ontology_ids(session: AsyncSession, claims: PermissionClaims,
                               user_id: Optional[str]) -> Set[str]:
    """The layers ``user_id`` may build a Playground graph on: approved org-wide layers, the
    starters, the samples' models, their own, and those shared with the Playground. Empty for
    anyone who isn't a member."""
    raise NotImplementedError


async def assert_offered(session: AsyncSession, claims: PermissionClaims, user_id: Optional[str],
                         ontology_id: str) -> OntologyORM:
    """The layer, when the caller may build on it here — else 404 ``unknown_ontology`` (missing or
    deleted), 422 ``ontology_not_published``, 403 ``ontology_not_offered``."""
    raise NotImplementedError


async def starter_types_of(session: AsyncSession, ontology_id: str,
                           used_entity_types: Optional[Sequence[str]] = None,
                           ) -> Tuple[Dict[str, EntityType], Dict[str, RelationshipType]]:
    """A layer's entity and relationship types as a starter graph's views read them (name,
    plural, icon, colour; a relationship's containment), keyed by type id — limited to
    ``used_entity_types`` (and the relationships among them) when given, in the layer's order."""
    raise NotImplementedError


async def create_owned(session: AsyncSession, *, claims: PermissionClaims, user_id: str,
                       playground_id: str, name: str, description: Optional[str],
                       source: Mapping[str, Any], publish: bool) -> OntologyORM:
    """A semantic layer of the caller's own in the Playground, from ``source``: ``{"blank": True}``,
    ``{"cloneOf": id}`` (a layer they can see), ``{"layer": <Semantic Layers export>}`` or
    ``{"infer": {"thingTypes": [...], "connectionTypes": [{"name", "ends"}]}}``. Owned by the
    Playground and made by ``user_id``; published when ``publish``. 409 ``layer_quota`` past the
    member's quota. Committed."""
    raise NotImplementedError


async def drop_owned(session: AsyncSession, ontology_id: str) -> None:
    """Remove a layer of one's own that nothing was built on (a failed start's)."""
    raise NotImplementedError
