"""The drafts and reviews policy of a data source: the level a new draft starts at, the levels a
draft may have, whether the person who opened a review may approve it, or merge it, how many
approvals a review needs, and whether open threads hold its merge.

Each field is a setting in the settings store (``config/versioned_graph_settings.py``:
``drafts.defaultVisibility``, ``drafts.levels``, ``drafts.selfApproval``, ``drafts.selfMerge``), and
resolves on its own, most specific first: the data source's graph's value (a fork's: its root's),
then its workspace's, then the platform's, then the built-in default. Drafts start public, may be
either level, and the opener may approve and merge. A level that is the only one allowed is also
where a new draft starts (the resolver derives it). The policy is read where a draft is created,
changes level, or a review is read, approved, merged or published. It is read fresh every time
(``strict``), so a tightened rule holds from the next such request.

:func:`resolve` is the same rule over the old columns (``WorkspaceORM``, ``WorkspaceDataSourceORM``),
which one release keeps writing (``settings.legacy``) and compares against.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

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
    ("review_required_approvals", "requiredApprovals", 0),
    ("review_threads_hold", "threadsHold", False),
)
#: Each API field's setting in the settings store.
KEYS = {"defaultVisibility": "drafts.defaultVisibility", "levels": "drafts.levels",
        "selfApproval": "drafts.selfApproval", "selfMerge": "drafts.selfMerge"}
#: Where a value came from, as the resolver names it, in this policy's words: the platform's, the
#: environment's and the built-in one are all ``default``.
_SOURCES = {"graph": SOURCE_DATA_SOURCE, "workspace": SOURCE_WORKSPACE}


@dataclass(frozen=True)
class EffectiveDraftsPolicy:
    """The policy one data source works under, with the level each field came from."""

    default_visibility: str = "public"
    levels: str = "any"
    self_approval: bool = True
    self_merge: bool = True
    #: Approvals a review needs: 0, everyone asked; N, any N that stand.
    required_approvals: int = 0
    #: Open threads hold a review's merge.
    threads_hold: bool = False
    #: ``(API field, data_source | workspace | default)`` pairs.
    sources: tuple = ()

    def allows(self, visibility: str) -> bool:
        """Whether a new draft may have this level."""
        return self.levels == "any" or self.levels == f"{visibility}_only"

    @property
    def rule(self):
        """What a review must have to merge (``review_state.ReviewRule``)."""
        from backend.app.services.versioning.review_state import ReviewRule

        return ReviewRule(required_approvals=self.required_approvals, threads_hold=self.threads_hold)

    def as_dict(self) -> dict:
        return {"defaultVisibility": self.default_visibility, "levels": self.levels,
                "selfApproval": self.self_approval, "selfMerge": self.self_merge,
                "requiredApprovals": self.required_approvals, "threadsHold": self.threads_hold,
                "sources": dict(self.sources)}


def settings_of(row: Any) -> dict:
    """What one level's old columns hold, by API field name; None where it sets nothing."""
    return {api: (getattr(row, column, None) if row is not None else None)
            for column, api, _default in FIELDS}


def resolve(workspace: Any = None, data_source: Any = None) -> EffectiveDraftsPolicy:
    """The policy the old columns give a data source and its workspace (either may be None). Pure."""
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
        required_approvals=int(values["requiredApprovals"]), threads_hold=bool(values["threadsHold"]),
        sources=tuple(sorted(sources.items())))


async def effective(workspace_id: Optional[str] = None, data_source_id: Optional[str] = None, *,
                    root_id: Optional[str] = None) -> EffectiveDraftsPolicy:
    """The policy in force, from the settings store: a data source's (``data_source_id``, in
    ``workspace_id``; ``root_id``: a fork's root data source, whose values it follows), a
    workspace's (no data source), or the platform's (neither). Read fresh."""
    from backend.app.services.settings import effective as settings, resolver

    ctx = await settings.refresh(strict=True)
    target = settings.target(workspace_id, data_source_id, {"fork_of": root_id} if root_id else None)
    values, sources = {}, {}
    for api, key in KEYS.items():
        found = resolver.resolve(ctx, key, target)
        values[api], sources[api] = found["effective"], _SOURCES.get(found["source"], SOURCE_DEFAULT)
    return EffectiveDraftsPolicy(
        default_visibility=values["defaultVisibility"], levels=values["levels"],
        self_approval=bool(values["selfApproval"]), self_merge=bool(values["selfMerge"]),
        sources=tuple(sorted(sources.items())))


async def load(session, data_source_id: str) -> EffectiveDraftsPolicy:
    """The effective policy of a data source (:func:`effective`): its row read by primary key, and
    a fork's parents' up to its root. Raises ``LookupError`` for a data source that isn't there."""
    from backend.app.db.models import WorkspaceDataSourceORM
    from backend.app.services import fork_sources

    ds = await session.get(WorkspaceDataSourceORM, data_source_id)
    if ds is None:
        raise LookupError(data_source_id)
    root = await fork_sources.governing_row(session, ds)
    return await effective(ds.workspace_id, ds.id, root_id=root.id if root is not ds else None)


async def own(session, scope: str, scope_id: str) -> Dict[str, Any]:
    """What a workspace (``scope`` ``workspace``) or a data source's graph (``graph``) chose itself
    in the settings store, by API field; None where it chose nothing."""
    from backend.app.services.settings import registry, store

    held = {r.key: r.value for r in await store.read_scope(session, registry().DOMAIN, scope,
                                                           scope_id)}
    return {api: held.get(key) for api, key in KEYS.items()}


async def save(session, scope: str, scope_id: str, changes: dict, *, actor: Optional[str],
               record, check=None) -> None:
    """Save ``changes`` (by API field; ``"inherit"`` clears one) at a workspace or a data source's
    graph, through the settings store as an old endpoint saves (``settings.legacy.save``, which
    runs ``check`` first: ``settings.service.checker`` for who saves, against the platform's limits
    and locks). When a field changed, ``record(session, before, after)`` runs in the same
    transaction with what the fields that changed were and became, by API field. Commits."""
    from backend.app.services.settings import legacy

    field_of = {key: api for api, key in KEYS.items()}

    async def recorded(s, change_set) -> None:
        await record(s, {field_of[a.key]: a.before_value for a in change_set.applied},
                     {field_of[a.key]: a.after_value for a in change_set.applied})

    await legacy.save(session, scope, scope_id,
                      {KEYS[api]: None if value == "inherit" else value
                       for api, value in changes.items()}, actor=actor, record=recorded,
                      check=check)


def apply(row: Any, changes: dict) -> tuple[dict, dict]:
    """Write ``changes`` (by API field; ``"inherit"`` clears one) onto a workspace or data source
    row's old columns. Returns what the fields that changed were and became, by API field."""
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
