"""Canonical view-visibility tiers — the backend's single source of truth.

Mirrors ``frontend/src/types/viewVisibility.ts``. The two files must stay
in lock-step: the DB CHECK constraints, the API validators and the access
evaluator all reference these values.

Prior to this module the three-value enum was duplicated as bare string
literals in five places (both CHECK constraints in ``db/models.py``, the
validator in ``endpoints/views.py``, and the branch chain in
``services/view_access.py``), with a further ~15 copies on the frontend
that had already drifted apart in wording and spelling. Adding a tier
meant a wide, silent-bug-prone sweep; now every caller imports from here.

The tiers form a **strictly widening ladder** — each reaches everyone the
one above it reaches, plus more:

===========  ==========================================================
``private``  creator + explicit ``resource_grants`` + workspace admins
             of the view's workspace
``workspace``+ anyone holding ``workspace:view:read`` in that workspace
``enterprise``+ anyone holding a binding in *any* workspace
``public``   + *any* authenticated account, including one with no
             workspace bindings at all
===========  ==========================================================

Why ``enterprise`` means "holds a binding somewhere": this codebase has
no ``organizations`` table — workspaces are the only tenancy unit, and
"org" exists solely as a role tier (``system:org-admin``). "Has at least
one workspace binding" is the honest proxy for organisation membership,
and it is computable from ``PermissionClaims.ws_perms`` with no query.
Without that distinction ``enterprise`` and ``public`` would be the same
tier — which is what ``enterprise`` degenerated to before this change,
where it was implemented as a bare "is authenticated" check.

``public`` is deliberately **authenticated-only**. There is no anonymous
or logged-out access to any view, and no share-link tokens.
"""
from __future__ import annotations

from enum import Enum


class ViewVisibility(str, Enum):
    """Visibility tier for a saved view.

    ``str`` mixin so existing string comparisons keep working —
    ``ViewVisibility.PRIVATE == "private"`` is True. Use
    ``ViewVisibility.<X>.value`` only when you need the bare string.
    """

    #: Creator, explicit grants, and workspace admins of its workspace.
    PRIVATE = "private"
    #: Anyone with read access in the view's own workspace.
    WORKSPACE = "workspace"
    #: Anyone with a binding in any workspace ("in the organisation").
    ENTERPRISE = "enterprise"
    #: Any authenticated account, workspace binding or not.
    PUBLIC = "public"


#: Tuple (not frozenset) because ordering matters for the DB CHECK
#: constraint text and for rendering the tier ladder in API errors.
VISIBILITY_VALUES: tuple[str, ...] = tuple(v.value for v in ViewVisibility)

#: The default for a newly created view, and the fallback for any legacy
#: row with a NULL ``visibility``. Fails safe — narrowest tier.
DEFAULT_VISIBILITY: str = ViewVisibility.PRIVATE.value


def visibility_check_constraint(column: str = "visibility") -> str:
    """SQL fragment for the ``CHECK`` constraint on a visibility column.

    Used by ``db/models.py`` for both ``views`` and ``context_models`` and
    by the alembic revision that widens the constraint, so the three can
    never disagree about the permitted set.
    """
    values = ", ".join(f"'{v}'" for v in VISIBILITY_VALUES)
    return f"{column} IN ({values})"


def is_valid_visibility(value: object) -> bool:
    """True when ``value`` is one of the permitted tiers."""
    return isinstance(value, str) and value in VISIBILITY_VALUES


__all__ = [
    "ViewVisibility",
    "VISIBILITY_VALUES",
    "DEFAULT_VISIBILITY",
    "visibility_check_constraint",
    "is_valid_visibility",
]
