"""ExportWorker — stream a graph (or as-of snapshot) to a downloadable, re-importable artifact.

Reads the versioned store (source of truth), denormalizes each node/edge to the shared template
columns (locked entity_id/urn/baseVersion + core + prop.* + properties_json), and writes them to
the object store via the chosen format adapter. A whole-graph export doubles as a **backup**: the
identity columns let a re-import restore/clone faithfully (round-trips to a zero diff when
unchanged). ``as_of_seq`` gives point-in-time exports (E5).

The job reads and writes a page at a time through :mod:`.stream`, as the streamed download does,
so an export of any size runs in flat memory; this module keeps the row shape both share.

It runs on the job's lease (:mod:`..job_lease`), and each attempt at it — each epoch — writes a
file of its own (:func:`epoch_key`): a worker taken over while still writing never writes into the
file its successor writes (a local store writes a file in place). The fenced finish names the
attempt's file as the job's result, so a superseded attempt's file is never the one downloaded. An
export has no cursor: taken over, it starts again.

A view package's export (``view_transfer.package.PackageExport``) writes the same data INTO the
package as it streams: one file, written once, never read back.
"""
from __future__ import annotations

import contextlib
import time
from typing import Any, Dict, List, Optional

from .. import db
from ..job_lease import Lease, Superseded
from ..models import JobORM
from . import stream
from .import_worker import lease_job

# How often a running export says how far it has got (a fenced checkpoint between chunks).
_PROGRESS_SECS = 5


def epoch_key(result_uri: str, epoch: int) -> str:
    """Where attempt ``epoch`` of an export writes its file: the key the job was created with for
    the first attempt, ``…/export-e<epoch>.<ext>`` beside it for each later one."""
    if epoch <= 1:
        return result_uri
    head, sep, name = result_uri.rpartition("/")
    stem, dot, ext = name.partition(".")
    return f"{head}{sep}{stem}-e{epoch}{dot}{ext}"


def example_template_records() -> List[Dict[str, Any]]:
    """Worked example rows for an empty graph's starter template (edit or delete them)."""
    return [
        {"kind": "node", "entity_id": "", "urn": "", "entityType": "Table",
         "displayName": "Example table", "qualifiedName": "analytics.example_table",
         "description": "An example row — edit or delete me", "prop.owner": "data-team", "_op": ""},
        {"kind": "node", "entity_id": "", "urn": "", "entityType": "Column",
         "displayName": "id", "qualifiedName": "analytics.example_table.id",
         "prop.dataType": "bigint", "_op": ""},
        {"kind": "edge", "entity_id": "", "edgeType": "CONTAINS",
         "sourceQualifiedName": "analytics.example_table",
         "targetQualifiedName": "analytics.example_table.id", "_op": ""},
    ]


class ExportWorker:
    def __init__(self, versioning, store, scope: Optional[Dict[str, Any]] = None,
                 options: Optional[Dict[str, Any]] = None, package=None) -> None:
        self._svc = versioning
        self._store = store
        self._scope = scope
        # A view package's export (view_transfer.package.PackageExport, its views already built):
        # the data is written into the package as it streams, and the package is the job's result.
        self._package = package
        options = options or {}
        # Property names to emit as (empty) columns — "add a new property".
        self._extra_props = [p for p in (options.get("props") or []) if str(p).strip()]
        # Row-scoping: an explicit id/urn set and/or entity types to include.
        self._select_ids = options.get("ids") or []
        self._select_types = options.get("types") or []

    async def run(self, job_id: str, *, lease: Optional[Lease] = None) -> Dict[str, int]:
        """Write the export on ``lease`` — the transfer lane's; called without one, the job is
        taken here (:func:`lease_job`) — to this attempt's own file, and finish the job naming it.
        Raises :class:`Superseded` once the job is no longer this worker's."""
        from .snapshot import pinned_reads

        lease = lease or await lease_job(job_id)
        async with db.graphver_session() as s:
            job = await s.get(JobORM, job_id)
            graph_id, fmt = job.graph_id, job.import_format or "ndjson"
            as_of_seq, branch_id = job.as_of_seq, job.branch_id
            result_uri = job.result_uri if self._package is None else self._package.key(job.result_uri)
            result_uri = epoch_key(result_uri, lease.epoch)

        # A draft as it stands now is pinned to no commit: every read of it comes from one
        # REPEATABLE READ transaction instead, or edits landing during a long export could give it
        # edges to nodes it never wrote, or nodes and edges from two different states.
        async with (pinned_reads() if branch_id and as_of_seq is None
                    else contextlib.nullcontext()):
            return await self._write(job_id, lease, graph_id, fmt, as_of_seq, branch_id,
                                     result_uri)

    async def _write(self, job_id: str, lease: Lease, graph_id: str, fmt: str,
                     as_of_seq: Optional[int], branch_id: Optional[str],
                     result_uri: str) -> Dict[str, int]:
        """:meth:`run`'s body: stream the snapshot to ``result_uri`` and finish the job."""
        from .snapshot import open_snapshot

        # Read a page at a time from one pinned snapshot (stream.py), never the whole state. A
        # branch_id (a working draft) composes main + committed + staged changes — so a user can
        # export their in-progress branch, edit in Excel, and re-import onto the same branch.
        snap = await open_snapshot(graph_id=graph_id, branch_id=branch_id, as_of_seq=as_of_seq)
        keep = (await stream.view_entities(snap, self._scope))["keep"] if self._scope else None
        selection = stream.Selection.of(keep=keep, ids=self._select_ids, types=self._select_types)
        # A spreadsheet makes every property its own column: existing ones + any the user asked to
        # add, so a brand-new property is an empty column ready to fill.
        tally = {"node": 0, "edge": 0}
        stats = stream.TypeStats() if self._package is not None else None
        written = 0
        said = time.monotonic()

        async def counted(chunks):
            """The file's bytes, counted. At most every ``_PROGRESS_SECS``, as a chunk comes, the
            job says how far it has got — this pass's records (a spreadsheet reads them all once
            for its columns first) and the bytes so far — in a fenced checkpoint, which is also
            where a superseded or stopping worker stops writing."""
            nonlocal written, said
            async for chunk in chunks:
                written += len(chunk)
                if time.monotonic() - said >= _PROGRESS_SECS:
                    said = time.monotonic()
                    lease.check()
                    async with db.graphver_session() as s:
                        # Merged into the row's summary, not replacing it: its ``takeovers`` is
                        # the claim's poison count, and an export that cleared it with every
                        # tick would be taken over forever by a worker it keeps killing.
                        row = await s.get(JobORM, job_id)
                        await lease.checkpoint(s, summary={
                            **(row.summary or {}), "nodes": tally["node"], "edges": tally["edge"],
                            "passes": tally.get("passes", 0), "bytes": written})
                yield chunk

        # It takes its turn with the streamed exports (the lease keeps the job alive while it waits).
        body = stream.in_turn(stream.write_export(
            lambda: stream.record_pages(snap, selection, tally=tally, stats=stats),
            fmt=fmt, props=self._extra_props))
        if self._package is not None:
            body = self._package.write(body, tally, stats)
        async with contextlib.aclosing(body):           # its turn goes back even if the store fails
            stat = await self._store.put_stream(result_uri, counted(body))

        summary = {"nodes": tally["node"], "edges": tally["edge"], "bytes": stat.size}
        if self._package is not None:
            summary["package"] = self._package.summary(stat.size)
        if not await lease.finish("completed", summary=summary, result_uri=result_uri):
            raise Superseded(f"export job {job_id} (epoch {lease.epoch}) was taken over before it "
                             "could finish")
        return summary
