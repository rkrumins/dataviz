"""One activity event for every commit that moves ``main`` (doc 19 §3.6).

Changing a published graph used to leave no event in the activity log: a person's publish, a
connector's sync, a key's bulk import and a revert were all visible only in the graph's own
history. Now each such commit records one event, filed under its data source. The event carries:

* the commit, its kind and its counts;
* who made it, through which API key and in which request — read from the commit itself
  (:mod:`.provenance`), so the event and the commit can never disagree.

So the activity log answers "what changed this data source, and who or what changed it" for people
and automation alike, and filters and exports like every other event.

The event is noted where ``main``'s head moves (:func:`note`) and recorded only once that
transaction has committed (:func:`.db.after_commit`). An attempt that is rolled back and retried
leaves nothing behind, and a failure to record never fails the commit. Steps that already record
their own event keep it, and note nothing here:
- turning version control on (``workspace.versioning.enabled``), whether the bootstrap job imports
  the graph or ``bulk_ingest`` seeds it in the enabling transaction;
- updating a fork from its parent (``workspace.versioning.fork_updated``).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from . import db, provenance

logger = logging.getLogger(__name__)

#: The event each kind of commit on ``main`` records.
EVENT_BY_KIND: Dict[str, str] = {
    "squash_publish": "workspace.versioning.published",   # a publish, a review's merge, a fork's merge
    "edit": "workspace.versioning.main_edited",            # a write straight to main (write-through)
    "import": "workspace.versioning.ingested",             # a bulk ingest
    "sync": "workspace.versioning.synced",                 # a snapshot sync, or a re-sync
    "revert": "workspace.versioning.reverted",
    "restore": "workspace.versioning.restored",
}


def note(session, graph, commit) -> None:
    """Record ``commit``'s event once ``session``'s transaction commits. ``graph`` is the graph
    whose ``main`` it moved; the event reads ``commit`` when it is recorded, so stats set later in
    the transaction are in it."""
    if commit.kind not in EVENT_BY_KIND:
        return
    graph_id, workspace_id, data_source_id = graph.id, graph.workspace_id, graph.data_source_id

    async def record() -> None:
        await record_main_commit(graph_id=graph_id, workspace_id=workspace_id,
                                 data_source_id=data_source_id, commit=commit)

    db.after_commit(session, record)


def details_of(graph_id: str, commit: Any) -> Dict[str, Any]:
    """What the event says of ``commit``."""
    kind = commit.actor_kind or provenance.actor_kind(commit.actor)
    out = {
        "graphId": graph_id,
        "commitId": commit.id,
        "commitSeq": commit.commit_seq,
        "kind": commit.kind,
        "message": commit.message,
        "changes": {op: int((commit.stats or {}).get(op) or 0) for op in ("create", "update", "delete")},
        "actorKind": kind,
        "automation": provenance.is_automation(kind, commit.actor, commit.api_key_id),
        "sourceBranchId": commit.source_branch_id,
    }
    return {k: v for k, v in out.items() if v is not None}


async def record_main_commit(*, graph_id: str, workspace_id: Optional[str],
                             data_source_id: Optional[str], commit: Any, session=None) -> None:
    """Write ``commit``'s activity event. Never raises: the commit it records has landed.
    ``session``: a management session to write it in (default: one of its own)."""
    from backend.app.common.activity_context import Provenance, current
    from backend.app.services.activity import recorder

    event_type = EVENT_BY_KIND.get(commit.kind)
    if event_type is None:
        return
    who = Provenance(actor_id=commit.actor, correlation_id=commit.correlation_id,
                     api_key_id=commit.api_key_id,
                     stated_reason=commit.change_reason or current().stated_reason)
    try:
        if session is not None:
            await _write(session, recorder, event_type, who, graph_id, workspace_id,
                         data_source_id, commit)
            return
        from backend.app.db.engine import get_async_session

        async with get_async_session() as s:
            await _write(s, recorder, event_type, who, graph_id, workspace_id, data_source_id, commit)
    except Exception:  # noqa: BLE001 — the activity log must never fail a commit that landed
        logger.warning("activity: %s for commit %s of %s not recorded", event_type, commit.id,
                       graph_id, exc_info=True)


async def _write(s, recorder, event_type, who, graph_id, workspace_id, data_source_id, commit):
    from backend.app.db.models import WorkspaceDataSourceORM

    ds = await s.get(WorkspaceDataSourceORM, data_source_id) if data_source_id else None
    target = recorder.data_source_target(ds) if ds is not None else {
        "workspace_id": workspace_id, "data_source_id": data_source_id,
        "target_type": "data_source", "target_id": data_source_id}
    await recorder.record_activity(s, event_type=event_type, provenance=who,
                                   details=details_of(graph_id, commit), best_effort=True, **target)
