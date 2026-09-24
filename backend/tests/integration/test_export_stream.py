"""Streamed export (live Postgres): the same records as the materializing export, in pages.

The streamed export reads a graph's state a page at a time from a snapshot pinned to one commit
(import_export/snapshot.py, stream.py). This proves it holds exactly what ``materialize_state``
holds — for published ``main``, an earlier commit, a draft (committed and staged changes, updates
and deletes), a draft as of one of its commits, and a copy-on-write fork — with a page size small
enough that every read spans many pages. Then that the view scope, a selection, and every format
written from it agree with the materializing path, and that an empty export is still a valid file.
"""
import asyncio
import json
import os

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.import_export import stream
from backend.app.services.versioning.import_export.export_worker import column_order, records_from_state
from backend.app.services.versioning.import_export.formats import get_adapter
from backend.app.services.versioning.import_export.rowmodel import normalize
from backend.app.services.versioning.import_export.snapshot import open_snapshot
from backend.app.services.versioning.service import GraphVersioningService

PAGE = 4          # every read spans several pages


def _n(eid, urn=None, t="Table", **props):
    payload = {"entityType": t, "displayName": eid, "qualifiedName": f"db.{eid}", "properties": props}
    if urn:
        payload["urn"] = urn
    return {"op": "create", "entity_kind": "node", "entity_id": eid, "payload": payload}


def _upd(create, **props):
    """``create``'s node, renamed and with ``props`` set."""
    payload = create["payload"]
    return {"op": "update", "entity_kind": "node", "entity_id": create["entity_id"],
            "payload": {**payload, "displayName": f"{payload['displayName']}!",
                        "properties": {**payload["properties"], **props}}}


def _del(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid}


def _e(eid, src, tgt, t="LINEAGE"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": t, "sourceEntityId": src, "targetEntityId": tgt}}


def _key(r):
    return (r["kind"], r["entity_id"])


def _materialized_filter(nodes, edges, scope, ids, types):
    """What the export kept when it filtered the whole materialized state in memory — the rules
    the stream must reproduce: the view's placed URNs, plus the containment descendants of those
    that inherit; then the selection; an edge only when both its ends are kept."""
    if scope:
        urn_to_eid = {p.get("urn"): eid for eid, p in nodes.items() if p.get("urn")}
        cont = {t.upper() for t in scope["containment_types"]}
        children = {}
        for e in edges.values():
            if str(e.get("edgeType") or "").upper() in cont:
                children.setdefault(e["sourceEntityId"], []).append(e["targetEntityId"])
        keep, stack = set(), [(urn_to_eid[u], u in scope["inherit_urns"])
                              for u in scope["assigned_urns"] if u in urn_to_eid]
        while stack:
            eid, descend = stack.pop()
            if eid not in keep:
                keep.add(eid)
                stack += [(c, True) for c in children.get(eid, [])] if descend else []
        nodes = {eid: p for eid, p in nodes.items() if eid in keep}
        edges = {eid: e for eid, e in edges.items()
                 if e["sourceEntityId"] in keep and e["targetEntityId"] in keep}
    if ids or types:
        lowered = {t.lower() for t in types}
        nodes = {eid: p for eid, p in nodes.items()
                 if (not ids or eid in ids or p.get("urn") in ids)
                 and (not types or str(p.get("entityType") or "").lower() in lowered)}
        edges = {eid: e for eid, e in edges.items()
                 if e["sourceEntityId"] in nodes and e["targetEntityId"] in nodes}
    return nodes, edges


async def _streamed(snap, sel):
    out = {}
    async for page in stream.record_pages(snap, sel):
        for r in page:
            assert _key(r) not in out, f"{_key(r)} streamed twice"
            out[_key(r)] = r
    return out


async def _check(svc, gid, bid, *, seq=None, scope=None, ids=(), types=(), label=""):
    """Streamed records == materialized records (then filtered the materializing way)."""
    state = await svc.materialize_state(graph_id=gid, branch_id=bid, as_of_seq=seq)
    nodes, edges = _materialized_filter(state["nodes"], state["edges"], scope, set(ids), set(types))
    want = {_key(r): r for r in records_from_state(nodes, edges)}

    snap = await open_snapshot(graph_id=gid, branch_id=bid, as_of_seq=seq, page_size=PAGE)
    keep = (await stream.view_entities(snap, scope))["keep"] if scope else None
    sel = stream.Selection.of(keep=keep, ids=ids, types=types)
    got = await _streamed(snap, sel)
    assert got == want, (label, sorted(set(got) ^ set(want)),
                         [k for k in set(got) & set(want) if got[k] != want[k]][:3])
    counted = await stream.count(snap, sel)
    assert counted == {"nodes": len(nodes), "edges": len(edges), "exact": True}, (label, counted)
    return snap, sel, want


async def _file(snap, sel, fmt, extra_props=()):
    columns = (await stream.columns_of(stream.record_pages(snap, sel), extra_props)
               if fmt in stream.SPREADSHEET_FORMATS else None)
    body = stream.write_export(lambda: stream.record_pages(snap, sel), fmt=fmt, props=extra_props)
    return b"".join([c async for c in body]), columns


async def _parse(fmt, blob):
    async def one():
        yield blob
    return [r async for r in get_adapter(fmt).parse(one())]


async def _head_seq(branch_id):
    async with db.graphver_session() as s:
        return await s.scalar(select(func.max(models.CommitORM.commit_seq)).where(
            models.CommitORM.branch_id == branch_id))


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    P = await svc.create_graph(data_source_id="ds_stream_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid, main = P["graph_id"], P["main_branch_id"]

    # 15 nodes (two without a URN), containment + lineage edges, then a commit that edits,
    # deletes and adds, so main has history to read as of.
    nodes = [_n(f"n{i:02d}", None if i in (7, 11) else f"urn:t:{i}", "Column" if i % 3 else "Table",
                owner=f"team{i % 2}", aliases=["a", "b"] if i % 4 == 0 else None, nested={"k": i} if i == 5 else None)
             for i in range(15)]
    edges = ([_e(f"c{i:02d}", "n00", f"n{i:02d}", "CONTAINS") for i in range(1, 6)]
             + [_e(f"c{i:02d}", "n06", f"n{i:02d}", "CONTAINS") for i in range(7, 10)]
             + [_e(f"l{i:02d}", f"n{i:02d}", f"n{i + 1:02d}") for i in range(10, 14)])
    await svc.apply_ops(graph_id=gid, actor="u", message="seed", ops=nodes + edges)
    seq1 = (await svc.get_graph(gid))["main_head_commit_seq"]
    await svc.apply_ops(graph_id=gid, actor="u", message="edit", ops=[
        _upd(nodes[1], owner="team9"), _del("n12"), _del("l12", "edge"), _del("l11", "edge"),
        _n("n15", "urn:t:15"), _e("l15", "n14", "n15")])

    await _check(svc, gid, main, label="main")
    await _check(svc, gid, main, seq=seq1, label="main as of the seed")

    # A draft: one committed round, then staged-only changes on top.
    d = await svc.open_draft(graph_id=gid, owner="u")
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="u",
                            ops=[_upd(nodes[2], owner="draft"), _del("n03"), _del("c03", "edge"), _n("n16", "urn:t:16")])
    await svc.checkpoint(graph_id=gid, branch_id=d, actor="u")
    draft_seq = await _head_seq(d)
    await svc.stage_changes(graph_id=gid, branch_id=d, actor="u",
                            ops=[_upd(nodes[4], owner="staged"), _del("n16"), _e("l16", "n00", "n13")])
    await _check(svc, gid, d, label="draft now")
    await _check(svc, gid, d, seq=draft_seq, label="draft as of its commit")

    # A fork reads its parent's main at the fork point, below its own commits.
    F = await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="u")
    fid, fmain = F["graph_id"], F["main_branch_id"]
    await svc.apply_ops(graph_id=fid, actor="u", message="fork edit",
                        ops=[_upd(nodes[5], owner="fork"), _del("n09"), _del("c09", "edge"), _n("n17", "urn:t:17")])
    await _check(svc, fid, fmain, label="fork")

    # The view scope: n00 inherits its children, n06 doesn't (n06 has no URN, so the canvas
    # keys it gv:<id>), n13 sits alone. The materializing filter only knows URNs.
    scope = {"assigned_urns": ["urn:t:0", "urn:t:13"], "inherit_urns": ["urn:t:0"],
             "containment_types": ["CONTAINS"]}
    await _check(svc, gid, main, scope=scope, label="view")
    snap = await open_snapshot(graph_id=gid, page_size=PAGE)
    found = await stream.view_entities(snap, {**scope, "assigned_urns": ["urn:t:0", "gv:n07", "n08", "urn:gone"]})
    assert found["placed"] == 4 and found["found"] == 3, found
    assert found["keep"] == {"n00", "n01", "n02", "n03", "n04", "n05", "n07", "n08"}, found

    # A selection, by id or URN and by type, alone and inside the view.
    await _check(svc, gid, main, ids=["n01", "urn:t:2", "n10", "urn:t:11"], label="ids")
    await _check(svc, gid, main, types=["table"], label="types")
    await _check(svc, gid, d, scope=scope, types=["column"], label="view + types on the draft")

    # Every format, from the stream, reads back to the same records.
    snap, sel, want = await _check(svc, gid, d, label="draft for files")
    blob, _ = await _file(snap, sel, "ndjson")
    assert {_key(r): r for r in await _parse("ndjson", blob)} == want
    blob, _ = await _file(snap, sel, "json")
    assert {_key(r): r for r in json.loads(blob)} == want
    # A spreadsheet holds text (and xlsx numbers), so compare what an import makes of each row:
    # the same normalized rows, list properties included.
    rows = {k: normalize(r, r["kind"]) for k, r in want.items()}
    for fmt in ("csv", "tsv", "xlsx"):
        blob, cols = await _file(snap, sel, fmt, extra_props=["steward"])
        if fmt != "xlsx":
            assert cols.columns == column_order(list(want.values()), {"node": ["steward"], "edge": ["steward"]})
        parsed = {_key(r): normalize(r, r["kind"]) for r in await _parse(fmt, blob)}
        assert parsed == rows, (fmt, [k for k in rows if parsed.get(k) != rows[k]][:3])
    assert cols.counts == {"node": sum(k == "node" for k, _ in want), "edge": sum(k == "edge" for k, _ in want)}
    assert rows[("node", "n00")]["properties"]["aliases"] == ["a", "b"], "a list property stays a list"

    # Nothing selected: still a valid file of every format, and the plan says it's empty.
    nothing = stream.Selection.of(types=["NoSuchType"])
    assert await stream.count(snap, nothing) == {"nodes": 0, "edges": 0, "exact": True}
    assert (await _file(snap, nothing, "json"))[0] == b"[]\n"
    assert (await _file(snap, nothing, "ndjson"))[0] == b""
    assert (await _file(snap, nothing, "csv"))[0].startswith("\ufeffkind,".encode())  # a BOM, then the header
    assert (await _file(snap, nothing, "csv"))[0].count(b"\n") == 1
    assert await _parse("xlsx", (await _file(snap, nothing, "xlsx"))[0]) == []

    # A whole published graph is counted from its head pointers.
    head = await open_snapshot(graph_id=gid)
    assert await head.head_counts() is not None
    assert await (await open_snapshot(graph_id=gid, as_of_seq=seq1)).head_counts() is None
    assert await (await open_snapshot(graph_id=fid)).head_counts() is None


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres")
def test_export_stream_e2e():
    asyncio.run(_run())
