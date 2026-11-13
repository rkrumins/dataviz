"""Full replaces by a property whose rows don't all carry it — Postgres, through the API.

A graph first loaded by urn holds a top-level node ``domain`` and tables ``a``, ``b`` and ``c``. A
source system then sends a nightly snapshot keyed by its own id, ``uid``: ``domain`` has none, and
``a`` and ``b`` carry one the graph has never seen.

* By ``identifier=prop.uid`` alone, the replace holds: ``domain`` has no ``uid`` (``no_key``), the
  urns of ``a`` and ``b`` belong to nodes that hold no ``uid`` (``two_entities``), and their edges
  name refused rows (``end_refused``). Its failure is the nodes' (``phase: nodes``), says the one
  change that fixes it, and nothing is deleted.
* By ``identifier=prop.uid,urn``, ``domain`` is found by its urn, ``a`` and ``b`` by theirs — they
  take their ``uid`` — ``c`` is deleted, ``d`` made; every id is kept. Sent again, it changes
  nothing: ``a`` and ``b`` are found by their ``uid`` now.
* By the property alone again, with ``maxRefusedRows=-1``: the refused rows keep what they name —
  ``domain``, and the edge from it a row names by urn — so the replace deletes nothing it meant to
  keep. A node a file names only as an edge's end is kept too.
* ``replaceScope=keyed`` deletes only what holds ``uid``: a node made in the app, which never had
  it, stays, with its edges, though the file leaves it out; an edge from it to a deleted keyed node
  goes with that node (``edgesCascaded``).
* On a greenfield graph the same file makes everything, ``domain`` under the id its urn derives,
  and sent again changes nothing.
"""
import asyncio
import json
import os
import shutil
import tempfile

import pytest

from backend.app.services.versioning import db, models

from .test_import_guide_examples import V1, _Guide, _app, _ok, _publisher

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


def _node(name: str, uid: str | None = None) -> dict:
    return {"kind": "node", "urn": f"urn:svc:{name}", "entityType": "Table", "displayName": name,
            **({"prop.uid": uid} if uid else {})}


def _edge(source: dict, target: dict) -> dict:
    """An edge naming each end by its uid when it has one, else by its urn."""
    out = {"kind": "edge", "edgeType": "FLOWS_TO"}
    for end, node in (("source", source), ("target", target)):
        if node.get("prop.uid"):
            out[f"{end}.uid"] = node["prop.uid"]
        else:
            out[f"{end}Urn"] = node["urn"]
    return out


def _file(*records) -> bytes:
    return "".join(json.dumps(r) + "\n" for r in records).encode()


async def _run(monkeypatch):
    from httpx import ASGITransport, AsyncClient

    from backend.app.services.versioning.service import GraphVersioningService

    from .test_api_graph_draft_journey import _StubCache, _StubManager

    await models.create_schema_and_partitions()
    root = tempfile.mkdtemp()
    app, graph_router, ie = _app(root)
    monkeypatch.setattr(graph_router, "provider_manager", _StubManager())
    monkeypatch.setattr(graph_router, "get_graph_cache", lambda: _StubCache())
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            g = _Guide(c, ie, GraphVersioningService())

            async def by_urn(gid):
                return {p["urn"]: eid for eid, p in (await g.main(gid)).items() if "urn" in p}

            async def edges(gid):
                main = await g.main(gid)
                names = {eid: p["displayName"] for eid, p in main.items() if "urn" in p}
                return sorted((names[p["sourceEntityId"]], names[p["targetEntityId"]])
                              for p in main.values() if "sourceEntityId" in p)

            async def replaced(gid, body, **params):
                return await upserted(gid, body, reconcileMode="replace", **params)

            async def upserted(gid, body, **params):
                job, done = await g.imported(gid, body, autoPublish="true", **params)
                if done["status"] == "completed" and done["summary"]["publish"]["state"] == "queued":
                    pub = await g.published_itself(gid, done)
                    assert pub["status"] == "completed", pub
                return job, done

            # ── A graph loaded by urn ───────────────────────────────────────────────────────────
            _ds, gid, _scope = await g.graph()
            domain, a, b, c_ = _node("domain"), _node("a"), _node("b"), _node("c")
            await replaced(gid, _file(domain, a, b, c_, _edge(domain, a), _edge(domain, b),
                                      _edge(domain, c_), _edge(a, b)), identifier="urn")
            ids = await by_urn(gid)
            assert set(ids) == {"urn:svc:domain", "urn:svc:a", "urn:svc:b", "urn:svc:c"}

            # The nightly snapshot, keyed by the source's uid: the top-level node has none.
            ka, kb, kd = _node("a", "U-A"), _node("b", "U-B"), _node("d", "U-D")
            nightly = _file(domain, ka, kb, kd, _edge(domain, ka), _edge(domain, kb), _edge(ka, kb),
                            _edge(ka, kd))

            # ── By the property alone: held, saying which change fixes it ───────────────────────
            job, held = await replaced(gid, nightly, identifier="prop.uid")
            assert held["status"] == "failed", held
            failure = held["summary"]["failure"]
            assert (failure["code"], failure["phase"]) == ("rows_refused", "nodes"), failure
            refused = held["summary"]["refused"]
            assert refused["byCode"]["no_key"] == 1 and refused["byCode"]["two_entities"] == 2, refused
            assert refused["byKind"]["node"] == 3, refused
            assert refused["byCode"].get("end_refused"), "edges to a refused row say so"
            assert refused["hints"] == {"by_urn": 3}, "domain, and a and b, whose urns hold no uid"
            assert "identifier=prop.uid,urn would find 3 of them by their urn" in held["errorMessage"], (
                held["errorMessage"])
            assert await by_urn(gid) == ids, "nothing deleted, nothing changed"

            # ── The property, then the urn: found, every id kept ───────────────────────────────
            _job, done = await replaced(gid, nightly, identifier="prop.uid,urn")
            assert done["status"] == "completed", done
            s = done["summary"]
            assert (s["new"], s["invalid"], s["deleted"]) == (2, 0, 2), s   # d, a→d; c, domain→c
            now = await by_urn(gid)
            assert set(now) == {"urn:svc:domain", "urn:svc:a", "urn:svc:b", "urn:svc:d"}
            assert all(now[u] == ids[u] for u in ("urn:svc:domain", "urn:svc:a", "urn:svc:b")), (
                "found by its urn, each node keeps its id")
            main = await g.main(gid)
            assert (main[now["urn:svc:a"]]["properties"]["uid"],
                    main[now["urn:svc:b"]]["properties"]["uid"]) == ("U-A", "U-B"), "they took their uid"
            assert await edges(gid) == [("a", "b"), ("a", "d"), ("domain", "a"), ("domain", "b")]

            _job, again = await replaced(gid, nightly, identifier="prop.uid,urn")
            assert (again["summary"]["new"], again["summary"]["updated"],
                    again["summary"]["deleted"]) == (0, 0, 0), again["summary"]
            assert again["summary"]["publish"]["state"] == "unchanged"

            # ── By the property alone within a budget: refused rows keep what they name ─────────
            _job, kept = await replaced(gid, nightly, identifier="prop.uid", maxRefusedRows="-1")
            assert kept["status"] == "completed", kept
            assert kept["summary"]["deleted"] == 0, "domain and the edges from it are kept"
            assert set(await by_urn(gid)) == set(now)
            assert await edges(gid) == [("a", "b"), ("a", "d"), ("domain", "a"), ("domain", "b")]

            # A node the file names only as an edge's end is kept.
            z = _node("z")
            await upserted(gid, _file(z), identifier="urn")
            await replaced(gid, _file(domain, ka, kb, kd, _edge(domain, ka), _edge(domain, kb),
                                      _edge(ka, kb), _edge(ka, kd), _edge(kd, z)),
                           identifier="prop.uid,urn")
            assert "urn:svc:z" in await by_urn(gid), "named as an edge's end: kept"

            # ── replaceScope=keyed: only what holds uid ─────────────────────────────────────────
            app_made = _node("made_in_app")
            await replaced(gid, _file(domain, ka, kb, kd, z, app_made, _edge(domain, ka),
                                      _edge(domain, kb), _edge(ka, kb), _edge(ka, kd),
                                      _edge(app_made, ka), _edge(app_made, kd)),
                           identifier="prop.uid,urn")
            _job, keyed = await replaced(gid, _file(ka, kb, _edge(ka, kb)), identifier="prop.uid,urn",
                                         replaceScope="keyed")
            assert keyed["status"] == "completed", keyed
            left = await by_urn(gid)
            assert "urn:svc:d" not in left, "d holds uid and the file leaves it out: deleted"
            assert {"urn:svc:domain", "urn:svc:z", "urn:svc:made_in_app"} <= set(left), (
                "nodes that never had uid are out of a keyed replace's scope")
            assert ("made_in_app", "a") in await edges(gid), "its edge to a kept node stays"
            assert keyed["summary"].get("edgesCascaded") == 1, keyed["summary"]   # made_in_app→d
            assert keyed["summary"]["replaceGuard"]["scope"] == "keyed"

            # ── A greenfield graph ──────────────────────────────────────────────────────────────
            _ds2, fresh, scope2 = await g.graph()
            _job, made = await replaced(fresh, nightly, identifier="prop.uid,urn")
            assert (made["status"], made["summary"]["new"], made["summary"]["invalid"]) == (
                "completed", 8, 0), made["summary"]
            from backend.app.services.versioning.import_export.resolve import pointer_id
            assert (await by_urn(fresh))["urn:svc:domain"] == pointer_id(scope2, "urn:svc:domain"), (
                "a node found by its urn is made under the id its urn derives")
            _job, same = await replaced(fresh, nightly, identifier="prop.uid,urn")
            assert (same["summary"]["new"], same["summary"]["updated"]) == (0, 0), same["summary"]
    finally:
        shutil.rmtree(root, ignore_errors=True)
        await db.dispose_engine()


def test_a_replace_by_a_property_finds_rows_without_it_by_their_urn_and_deletes_nothing_it_names(
        monkeypatch, data_sources):
    from backend.app.services import permission_service

    monkeypatch.setattr(permission_service, "resolve", _publisher)
    asyncio.run(_run(monkeypatch))
