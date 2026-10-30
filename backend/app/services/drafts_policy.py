"""The drafts and reviews policy of a data source: the level a new draft starts at, the levels a
draft may have, and whether the person who opened a review may approve it, or merge it.

Each field resolves on its own, most specific first: the data source's override
(``WorkspaceDataSourceORM``), then its workspace's setting (``WorkspaceORM``), then the built-in
default — drafts start public, may be either level, and the opener may approve and merge. NULL at a
level means "not set here". The policy is read where a draft is created, changes level, or a review
is approved, merged or published, never on a read, and is never cached: a tightened rule holds from
the next such request.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

VISIBILITIES = ("public", "private")
LEVELS = ("any", "public_only", "private_only")

SOURCE_DATA_SOURCE = "data_source"
SOURCE_WORKSPACE = "workspace"
SOURCE_DEFAULT = "default"

#: (column on both rows, API field, built-in default)
FIELDS = (
    ("draft_default_visibility", "defaultVisibility", "public"),
    ("draft_levels", "levels", "any"),
    ("review_self_approval", "selfApproval", True),
    ("review_self_merge", "selfMerge", True),
)


@dataclass(frozen=True)
class EffectiveDraftsPolicy:
    """The policy one data source works under, with the level each field came from."""

    default_visibility: str = "public"
    levels: str = "any"
    self_approval: bool = True
    self_merge: bool = True
    #: ``(API field, data_source | workspace | default)`` pairs.
    sources: tuple = ()

    def allows(self, visibility: str) -> bool:
        """Whether a new draft may have this level."""
        return self.levels == "any" or self.levels == f"{visibility}_only"

    def as_dict(self) -> dict:
        return {"defaultVisibility": self.default_visibility, "levels": self.levels,
                "selfApproval": self.self_approval, "selfMerge": self.self_merge,
                "sources": dict(self.sources)}


def settings_of(row: Any) -> dict:
    """What one level holds itself, by API field name; None where it sets nothing."""
    return {api: (getattr(row, column, None) if row is not None else None)
            for column, api, _default in FIELDS}


def resolve(workspace: Any = None, data_source: Any = None) -> EffectiveDraftsPolicy:
    """The effective policy for a data source and its workspace (either may be None). Pure."""
    values, sources = {}, {}
    for column, api, default in FIELDS:
        values[api], sources[api] = default, SOURCE_DEFAULT
        for row, source in ((data_source, SOURCE_DATA_SOURCE), (workspace, SOURCE_WORKSPACE)):
            value = getattr(row, column, None) if row is not None else None
            if value is not None:
                values[api], sources[api] = value, source
                break
    # A level that is the only one allowed is also where a new draft starts.
    if values["levels"] != "any":
        only = values["levels"].removesuffix("_only")
        if values["defaultVisibility"] != only:
            values["defaultVisibility"], sources["defaultVisibility"] = only, sources["levels"]
    return EffectiveDraftsPolicy(
        default_visibility=values["defaultVisibility"], levels=values["levels"],
        self_approval=bool(values["selfApproval"]), self_merge=bool(values["selfMerge"]),
        sources=tuple(sorted(sources.items())))


async def load(session, data_source_id: str) -> EffectiveDraftsPolicy:
    """The effective policy of a data source: two reads by primary key, never a join. Raises
    ``LookupError`` for a data source that isn't there."""
    from backend.app.db.models import WorkspaceDataSourceORM, WorkspaceORM

    ds = await session.get(WorkspaceDataSourceORM, data_source_id)
    if ds is None:
        raise LookupError(data_source_id)
    return resolve(await session.get(WorkspaceORM, ds.workspace_id), ds)


def apply(row: Any, changes: dict) -> tuple[dict, dict]:
    """Write ``changes`` (by API field; ``"inherit"`` clears one) onto a workspace or data source
    row. Returns what the fields that changed were and became, by API field."""
    before = settings_of(row)
    for column, api, _default in FIELDS:
        if api in changes:
            value = changes[api]
            setattr(row, column, None if value == "inherit" else value)
    after = settings_of(row)
    changed = [api for api in after if after[api] != before[api]]
    return ({api: before[api] for api in changed}, {api: after[api] for api in changed})


def changes_from(body: Any) -> dict:
    """The fields a request set, by API field name (``"inherit"`` included; left out excluded)."""
    sent = body.model_dump(by_alias=True, exclude_unset=True)
    return {api: sent[api] for _column, api, _default in FIELDS if api in sent and sent[api] is not None}
