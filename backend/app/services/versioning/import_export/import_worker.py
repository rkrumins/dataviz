"""ImportWorker — parse an uploaded file, resolve it, and build it onto a draft branch.

Independent of the aggregation/ingestion worker: it copies that stateless-worker *pattern* but
imports none of it, and drives the **versioning service** (drafts), so an import is exactly the
manual create/edit flow at scale — repeated imports stack on one draft like successive manual edits.

Phases (all params on the ``JobORM`` row):
  parse    stream ``source_uri`` from the object store -> the format adapter -> :func:`normalize`
           -> ``import_rows`` (cursor-ordered, never buffering the whole file);
  resolve  match rows to the draft's composed state and build versioned ops (:func:`resolve_rows`);
  build    apply ops in ``IMPORT_COMMIT_WINDOW`` windows via ``apply_ops(branch_id=draft)``.

Invalid rows are quarantined (partial acceptance), not fatal; the tally lands on ``job.summary``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List

from sqlalchemy import select, update

from .. import config, db
from ..ids import prefixed_id
from ..models import BranchORM, ImportRowORM, JobORM
from .formats import get_adapter
from .resolve import resolve_rows
from .rowmodel import normalize

_PARSE_BATCH = 2000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _chunks(seq: List[Any], size: int):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


class ImportWorker:
    def __init__(self, versioning, store) -> None:
        self._svc = versioning
        self._store = store

    async def run(self, job_id: str) -> Dict[str, int]:
        job = await self._load_running(job_id)
        graph_id, branch_id = job["graph_id"], job["branch_id"]
        actor = await self._branch_owner(graph_id, branch_id)

        await self._parse(job_id, job["source_uri"], job["import_format"])
        summary = await self._resolve_and_build(job_id, graph_id, branch_id, actor)

        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            row.status = "completed"
            row.completed_at = _now()
            row.updated_at = _now()
            row.summary = summary
            row.processed = sum(summary.values())
        return summary

    # ------------------------------------------------------------------ #
    async def _load_running(self, job_id: str) -> Dict[str, Any]:
        async with db.graphver_session() as s:
            row = await s.get(JobORM, job_id)
            if row is None:
                raise ValueError(f"unknown import job {job_id}")
            row.status = "running"
            row.started_at = _now()
            row.updated_at = _now()
            return {"graph_id": row.graph_id, "branch_id": row.branch_id,
                    "source_uri": row.source_uri, "import_format": row.import_format,
                    "reconcile_mode": row.reconcile_mode}

    async def _branch_owner(self, graph_id: str, branch_id: str) -> str:
        async with db.graphver_session() as s:
            branch = await s.get(BranchORM, branch_id)
            return (branch.owner if branch else None) or "system"

    async def _reject_binary(self, source_uri: str) -> None:
        """Fail fast with a clear message on a binary (non-text) file — uploading an Excel
        workbook (.xlsx/.xls) instead of CSV is a common mistake that would otherwise parse into
        meaningless rows. Raised in the normal flow (not inside a generator) so the message
        surfaces on the job."""
        async for chunk in self._store.open_stream(source_uri):
            if chunk[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
                raise ValueError(
                    "This looks like an Excel workbook (.xlsx). Please open it and 'Save As' "
                    "CSV (UTF-8), then import that file — spreadsheet workbooks aren't supported yet.")
            if chunk[:4] == b"\xd0\xcf\x11\xe0":
                raise ValueError(
                    "This looks like a legacy Excel file (.xls). Please save it as CSV and import that.")
            return  # only the first chunk is needed to sniff the file type

    async def _parse(self, job_id: str, source_uri: str, fmt: str) -> int:
        await self._reject_binary(source_uri)
        adapter = get_adapter(fmt)
        batch: List[ImportRowORM] = []
        idx = 0
        async for raw in adapter.parse(self._store.open_stream(source_uri)):
            kind = raw.get("kind")
            if kind not in ("node", "edge"):
                continue  # tallied as skipped; a malformed record never aborts the parse
            batch.append(ImportRowORM(job_id=job_id, row_index=idx, kind=kind,
                                      raw=normalize(raw, kind)))
            idx += 1
            if len(batch) >= _PARSE_BATCH:
                await self._flush(batch)
                batch = []
        if batch:
            await self._flush(batch)
        return idx

    async def _flush(self, batch: List[ImportRowORM]) -> None:
        async with db.graphver_session() as s:
            s.add_all(batch)

    async def _resolve_and_build(self, job_id, graph_id, branch_id, actor) -> Dict[str, int]:
        async with db.graphver_session() as s:
            rows = (await s.execute(
                select(ImportRowORM).where(ImportRowORM.job_id == job_id)
                .order_by(ImportRowORM.row_index))).scalars().all()
            norm_rows = [{**r.raw, "_row_index": r.row_index} for r in rows]

        indexes = await self._svc.entity_indexes(graph_id=graph_id, branch_id=branch_id)
        ops, resolutions = resolve_rows(norm_rows, indexes, mint_id=lambda: prefixed_id("ent"))

        await self._persist_resolutions(job_id, resolutions)

        # Apply accepted ops in windows onto the draft (never main).
        for window in _chunks(ops, config.IMPORT_COMMIT_WINDOW):
            await self._svc.apply_ops(graph_id=graph_id, ops=window, actor=actor,
                                      branch_id=branch_id, message="import")

        summary: Dict[str, int] = {"new": 0, "updated": 0, "deleted": 0, "invalid": 0}
        for res in resolutions:
            summary[res["status"]] = summary.get(res["status"], 0) + 1
        return summary

    async def _persist_resolutions(self, job_id: str, resolutions) -> None:
        async with db.graphver_session() as s:
            for res in resolutions:
                await s.execute(
                    update(ImportRowORM)
                    .where(ImportRowORM.job_id == job_id,
                           ImportRowORM.row_index == res["_row_index"])
                    .values(matched_entity_id=res["matched_entity_id"],
                            resolved_op=res["resolved_op"], status=res["status"],
                            reasons=res["reasons"] or None))
