"""Dates and moments through export -> a spreadsheet -> import (live Postgres).

A moment saved in any form is stored in one (UTC, ``…Z``). It goes out in an export as that text.
If a spreadsheet writes it back its own way (a CSV opened and saved in Excel: ``18/11/2026 05:42``,
``04/03/2026``), the import reads it as unchanged. A moment changed in the file, as text or as an
Excel date cell, is stored in the one form again.
"""
import asyncio
import csv
import io
import os
import shutil
import tempfile
from datetime import datetime

import openpyxl
import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db, models
from backend.app.services.versioning.entity_audit import entity_summary
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.service import GraphVersioningService


async def _drain(aiter):
    out = b""
    async for c in aiter:
        out += c
    return out


async def _bytes(b):
    yield b


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    g = await svc.create_graph(data_source_id="ds_dt_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = g["graph_id"]
    # Saved with an offset and a space: stored in UTC, one way.
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=[{
        "op": "create", "entity_kind": "node", "entity_id": "ent_A",
        "payload": {"urn": "urn:A", "entityType": "Table", "displayName": "A", "qualifiedName": "a",
                    "properties": {"due": "2026-11-18 07:42+02:00", "certified": "2026-03-04", "owner": "ana"}}}])

    async def props(branch=None):
        s = await entity_summary(svc, graph_id=gid, entity_id="ent_A", branch_id=branch, include_value=True)
        return s["value"]["node"]["properties"]

    assert await props() == {"due": "2026-11-18T05:42:00Z", "certified": "2026-03-04", "owner": "ana"}

    root = tempfile.mkdtemp(prefix="dt-rt-")
    try:
        store = LocalFsObjectStore(root)
        ie = ImportExportService(versioning=svc, store=store)

        async def export(fmt):
            job = await ie.create_export_job(workspace_id="ws1", data_source_id=gid, graph_id=gid,
                                             actor="u", export_format=fmt)
            await ie.run_export(job["job_id"])
            return await _drain(store.open_stream(job["result_uri"]))

        async def import_back(blob, fmt, key):
            await store.put_stream(key, _bytes(blob))
            job = await ie.create_import_job(workspace_id="ws1", data_source_id=gid, graph_id=gid, actor="u",
                                             import_format=fmt, source_uri=key)
            return await ie.run_import(job["job_id"]), job["branch_id"]

        # ---- CSV: the moment goes out as its stored text ----
        text = (await export("csv")).decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(text)))
        node = next(r for r in rows if r.get("kind") == "node")
        assert node["prop.due"] == "2026-11-18T05:42:00Z" and node["prop.certified"] == "2026-03-04"

        def with_cells(**cells):
            out = io.StringIO()
            w = csv.DictWriter(out, fieldnames=list(rows[0].keys()))
            w.writeheader()
            for r in rows:
                w.writerow({**r, **cells} if r.get("kind") == "node" else r)
            return out.getvalue().encode()

        # Saved by a spreadsheet in its own writing: nothing changed.
        summary, _ = await import_back(with_cells(**{"prop.due": "18/11/2026 05:42", "prop.certified": "04/03/2026"}),
                                       "csv", "in/excel-same.csv")
        assert summary["unchanged"] == 1 and summary["updated"] == 0, summary

        # Changed in the file — day-first only (the 19th): stored in the one form, the date kept a date.
        summary, branch = await import_back(with_cells(**{"prop.due": "19/11/2026 06:00", "prop.certified": "2026-03-25"}),
                                            "csv", "in/excel-changed.csv")
        assert summary["updated"] == 1, summary
        assert await props(branch) == {"due": "2026-11-19T06:00:00Z", "certified": "2026-03-25", "owner": "ana"}

        # A date that reads two ways, neither the stored one, is refused, not guessed.
        summary, _ = await import_back(with_cells(**{"prop.certified": "05/03/2026"}), "csv", "in/excel-unclear.csv")
        assert summary["invalid"] == 1 and summary["updated"] == 0, summary

        # ---- Excel: retyped as a date cell, it comes back as one moment ----
        book = openpyxl.load_workbook(io.BytesIO(await export("xlsx")))
        sheet = book["Nodes"]
        header = [c.value for c in sheet[1]]
        sheet.cell(row=2, column=header.index("prop.due") + 1, value=datetime(2026, 11, 20, 7, 0))
        out = io.BytesIO()
        book.save(out)
        summary, branch = await import_back(out.getvalue(), "xlsx", "in/edited.xlsx")
        assert summary["updated"] == 1, summary
        assert (await props(branch))["due"] == "2026-11-20T07:00:00Z"
    finally:
        shutil.rmtree(root, ignore_errors=True)

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_moments_roundtrip_e2e():
    asyncio.run(_run())
