"""The one shape a refusal takes on the view, subset and membership routes.

Every refusal answers ``{"detail": {"reason": ..., "message": ..., ...}}``:
- ``reason`` is a stable code a client branches on — ``changed``,
  ``base_missing``, ``over_cap``, ``too_soon`` — and never changes wording;
- ``message`` is the words to show a person;
- anything else is what that reason carries: ``definitionHash`` with
  ``changed``, the counts with ``over_cap``, ``permission`` with
  ``missing_permission``.

A busy graph (429/503, ``ProviderBusy``) is answered by the app's own handler,
whose body carries ``code`` (``PROVIDER_BUSY``, ...) and ``message`` alongside
the older prose ``reason``, and a ``Retry-After`` header.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field


def refused(status: int, reason: str, message: str, *,
            headers: dict[str, str] | None = None, **carried: Any) -> HTTPException:
    """A refusal: ``reason`` to branch on, ``message`` to show, and what it carries."""
    return HTTPException(status_code=status, headers=headers,
                         detail={"reason": reason, "message": message, **carried})


class RefusalDetail(BaseModel):
    """Why a request was refused."""

    model_config = ConfigDict(extra="allow")

    reason: str = Field(description="A stable code to branch on, e.g. `changed`, `base_missing`, "
                                    "`over_cap`, `too_soon`. Its wording never changes.")
    message: str = Field(description="Words to show a person.")


class Refusal(BaseModel):
    """The body of every refusal on these routes."""

    detail: RefusalDetail


_RETRY_AFTER = {"Retry-After": {"description": "Seconds to wait before asking again.",
                                "schema": {"type": "integer"}}}

#: What each status means on these routes, for their OpenAPI ``responses``.
_MEANS = {
    304: "Not modified: the `ETag` sent in `If-None-Match` still matches.",
    400: "Malformed: a cursor this server didn't issue (`bad_cursor`), or no workspace.",
    403: "Refused: a missing permission (`missing_permission`), a switch that is off "
         "(`feature_disabled`), or a share link asking outside its view (`link_other_view`).",
    404: "Not found, or not one you can read.",
    409: "Conflict with what is stored: someone else changed it (`changed`, with the "
         "`definitionHash` stored now), its base view is gone (`base_missing`), it is frozen "
         "(`frozen`), or it can't be changed in a draft (`draft_refused`).",
    422: "Can't be done as asked; `reason` and `message` say why.",
    429: "Busy (`PROVIDER_BUSY`) or too soon (`too_soon`): ask again after `Retry-After`.",
    503: "The graph store or its cache can't answer just now: ask again after `Retry-After`.",
}


def refusal_responses(*statuses: int) -> dict[int, dict[str, Any]]:
    """OpenAPI ``responses`` for the refusals a route answers with."""
    out: dict[int, dict[str, Any]] = {}
    for status in statuses:
        entry: dict[str, Any] = {"description": _MEANS[status]}
        if status not in (304,):
            entry["model"] = Refusal
        if status in (429, 503):
            entry["headers"] = _RETRY_AFTER
        out[status] = entry
    return out
