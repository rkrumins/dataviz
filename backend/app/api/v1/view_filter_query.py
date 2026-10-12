"""The Explorer's view filters, declared once.

``GET /views/`` and ``GET /views/stats`` must accept exactly the same filters:
the stats bar describes the population the list returns, and the two drift the
moment a filter is added to one signature and not the other. Both take this
dependency, and the repository applies it through ``_apply_view_filters``.
"""
from __future__ import annotations

from dataclasses import dataclass, fields
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Query

_SOURCE_KINDS = ("versioned", "external")
_CONTRIBUTOR_ROLES = ("created", "edited", "published")
# Each id is a bind parameter in an IN list; a person picker never needs more.
_MAX_CONTRIBUTORS = 50


@dataclass(frozen=True)
class ViewFilterQuery:
    visibility: Optional[str] = None
    visibility_in: Optional[List[str]] = None
    workspace_id: Optional[str] = None
    workspace_ids: Optional[List[str]] = None
    context_model_id: Optional[str] = None
    data_source_id: Optional[str] = None
    view_type: Optional[str] = None
    view_types: Optional[List[str]] = None
    created_by: Optional[str] = None
    created_by_in: Optional[List[str]] = None
    created_after: Optional[str] = None
    created_before: Optional[str] = None
    updated_after: Optional[str] = None
    updated_before: Optional[str] = None
    search: Optional[str] = None
    tags: Optional[List[str]] = None
    favourited_only: bool = False
    include_deleted: bool = False
    deleted_only: bool = False
    attention_only: bool = False
    source_kind: Optional[str] = None
    contributor_in: Optional[List[str]] = None
    contributor_role: Optional[str] = None
    # Not a repository filter: the endpoint resolves it against the caller's
    # grants (``_category_filters``).
    category: Optional[str] = None

    def repo_kwargs(self) -> Dict[str, Any]:
        """Keyword arguments for the ``_apply_view_filters``-based repository reads."""
        kwargs = {f.name: getattr(self, f.name) for f in fields(self)}
        del kwargs["category"]
        return kwargs

    def cache_key(self) -> tuple:
        """Hashable, and the same for the same filters sent in any order."""
        return tuple(
            tuple(sorted(value)) if isinstance(value, list) else value
            for value in (getattr(self, f.name) for f in fields(self))
        )


def _instant(value: Optional[str], param_name: str) -> Optional[str]:
    """A date or date-time from the query string, in the shape views store.

    Timestamps are TEXT from ``datetime.now(timezone.utc).isoformat()`` and are
    compared as strings, so a bound orders correctly only in that same shape:
    UTC, ``+00:00``. A bare date is midnight UTC; a naive date-time is UTC.
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except (ValueError, OverflowError):
        raise HTTPException(
            status_code=422, detail=f"{param_name} must be an ISO date or date-time",
        )


async def view_filter_query(
    visibility: Optional[str] = Query(None),
    visibility_in: Optional[List[str]] = Query(None, alias="visibilityIn"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    workspace_ids: Optional[List[str]] = Query(None, alias="workspaceIds"),
    context_model_id: Optional[str] = Query(None, alias="contextModelId"),
    data_source_id: Optional[str] = Query(None, alias="dataSourceId"),
    view_type: Optional[str] = Query(None, alias="viewType"),
    view_types: Optional[List[str]] = Query(None, alias="viewTypes"),
    created_by: Optional[str] = Query(None, alias="createdBy"),
    created_by_in: Optional[List[str]] = Query(None, alias="createdByIn"),
    created_after: Optional[str] = Query(None, alias="createdAfter"),
    created_before: Optional[str] = Query(None, alias="createdBefore"),
    updated_after: Optional[str] = Query(
        None,
        alias="updatedAfter",
        description="Last changed (settings/layout edit or data publish) on or after.",
    ),
    updated_before: Optional[str] = Query(None, alias="updatedBefore"),
    search: Optional[str] = Query(None),
    tags: Optional[List[str]] = Query(None),
    favourited_only: bool = Query(False, alias="favouritedOnly"),
    include_deleted: bool = Query(False, alias="includeDeleted"),
    deleted_only: bool = Query(False, alias="deletedOnly"),
    attention_only: bool = Query(False, alias="attentionOnly"),
    source_kind: Optional[str] = Query(
        None, alias="sourceKind", description="versioned | external",
    ),
    contributor_in: Optional[List[str]] = Query(
        None,
        alias="contributorIn",
        description=f"User ids (at most {_MAX_CONTRIBUTORS}); OR across them.",
    ),
    contributor_role: Optional[str] = Query(
        None,
        alias="contributorRole",
        description=(
            "created | edited | published. Without it, contributorIn matches "
            "views the people created or last edited."
        ),
    ),
    category: Optional[str] = Query(
        None,
        description=(
            "Explorer category with server-side meaning: "
            "``shared-with-me`` = views shared with the caller through "
            "an explicit grant (excluding their own)."
        ),
    ),
) -> ViewFilterQuery:
    if source_kind and source_kind not in _SOURCE_KINDS:
        raise HTTPException(
            status_code=422, detail="sourceKind must be one of: versioned, external",
        )
    if contributor_role and contributor_role not in _CONTRIBUTOR_ROLES:
        raise HTTPException(
            status_code=422,
            detail="contributorRole must be one of: created, edited, published",
        )
    if contributor_in and len(contributor_in) > _MAX_CONTRIBUTORS:
        raise HTTPException(
            status_code=422,
            detail=f"contributorIn accepts at most {_MAX_CONTRIBUTORS} people",
        )
    return ViewFilterQuery(
        visibility=visibility,
        visibility_in=visibility_in,
        workspace_id=workspace_id,
        workspace_ids=workspace_ids,
        context_model_id=context_model_id,
        data_source_id=data_source_id,
        view_type=view_type,
        view_types=view_types,
        created_by=created_by,
        created_by_in=created_by_in,
        created_after=_instant(created_after, "createdAfter"),
        created_before=_instant(created_before, "createdBefore"),
        updated_after=_instant(updated_after, "updatedAfter"),
        updated_before=_instant(updated_before, "updatedBefore"),
        search=search,
        tags=tags,
        favourited_only=favourited_only,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        attention_only=attention_only,
        source_kind=source_kind,
        contributor_in=contributor_in,
        contributor_role=contributor_role,
        category=category,
    )
