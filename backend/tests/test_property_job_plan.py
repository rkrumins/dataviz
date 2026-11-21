"""A bulk property job's plan and its request, without a database.

``plan_patch`` is what one operation does to one entity's properties — the whole of what a job
writes, window after window — so each kind's writes and skips are pinned here; the request models
and ``_check_property_job`` are what the routes refuse before a job is made, each with its code.
"""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from backend.app.services.versioning import config
from backend.app.services.versioning.import_export import property_job as pj
from backend.app.services.versioning.ontology import EntityRule, OntologyRules
from backend.common.property_patch import PROP_DELETE


def _op(kind, key="owner", **kw):
    return {"kind": kind, "key": key, "onConflict": "skip", **kw}


# ── the plan ──────────────────────────────────────────────────────────────────
def test_set_writes_the_value_and_skips_an_entity_that_holds_it():
    op = _op("set", value="ana")
    assert pj.plan_patch(op, {}) == {"owner": "ana"}
    assert pj.plan_patch(op, {"owner": "bo"}) == {"owner": "ana"}
    assert pj.plan_patch(op, {"owner": "ana", "x": 1}) is None


def test_set_compares_values_as_stored():
    """1, 1.0, True and "1" are four values: each is written over the others."""
    for held in (True, 1.0, "1"):
        assert pj.plan_patch(_op("set", value=1), {"owner": held}) == {"owner": 1}
    assert pj.plan_patch(_op("set", value={"a": [1, 2]}), {"owner": {"a": [1, 2]}}) is None
    assert pj.plan_patch(_op("set", value=None), {"owner": None}) is None


def test_fill_empty_writes_only_where_the_key_is_absent_null_or_blank():
    op = _op("fillEmpty", value="ana")
    for props in ({}, {"owner": None}, {"owner": ""}):
        assert pj.plan_patch(op, props) == {"owner": "ana"}
    for held in ("bo", 0, False, []):
        assert pj.plan_patch(op, {"owner": held}) is None


def test_remove_deletes_a_held_key_and_skips_the_rest():
    assert pj.plan_patch(_op("remove"), {"owner": None}) == {"owner": PROP_DELETE}
    assert pj.plan_patch(_op("remove"), {"other": 1}) is None


def test_rename_moves_the_value_and_skips_a_conflict_unless_it_overwrites():
    op = _op("rename", to="steward")
    assert pj.plan_patch(op, {"owner": "ana"}) == {"steward": "ana", "owner": PROP_DELETE}
    assert pj.plan_patch(op, {"other": 1}) is None                       # no source: unchanged
    held = {"owner": "ana", "steward": "bo"}
    assert pj.plan_patch(op, held) is None and pj.is_conflict(op, held)
    over = {**op, "onConflict": "overwrite"}
    assert pj.plan_patch(over, held) == {"steward": "ana", "owner": PROP_DELETE}
    assert not pj.is_conflict(over, held)
    # The new key holds the value already: only the old one goes.
    assert pj.plan_patch(over, {"owner": "ana", "steward": "ana"}) == {"owner": PROP_DELETE}


def test_copy_is_a_rename_that_keeps_the_key():
    op = _op("copy", to="steward")
    assert pj.plan_patch(op, {"owner": "ana"}) == {"steward": "ana"}
    assert pj.plan_patch(op, {"owner": "ana", "steward": "bo"}) is None
    assert pj.is_conflict(op, {"owner": "ana", "steward": "bo"})
    over = {**op, "onConflict": "overwrite"}
    assert pj.plan_patch(over, {"owner": "ana", "steward": "bo"}) == {"steward": "ana"}
    assert pj.plan_patch(over, {"owner": "ana", "steward": "ana"}) is None
    assert not pj.is_conflict(op, {"steward": "bo"})                      # no source: no conflict


def test_a_window_plans_each_entity_once_and_counts_what_it_skips():
    found = {"urn:a": ("A", {"owner": "x"}, "urn:a"),
             "gv:A": ("A", {"owner": "x"}, "urn:a"),                     # the same entity again
             "urn:b": ("B", {"owner": "y", "steward": "z"}, "urn:b"),
             "urn:c": ("C", {}, "urn:c")}
    ops, counts, refused = pj.plan_window(_op("rename", to="steward"), found)
    assert ops == [{"op": "update", "entity_kind": "node", "entity_id": "A",
                    "payload": {"properties": {"steward": "x", "owner": PROP_DELETE}}}]
    assert counts == {"changed": 1, "unchanged": 2, "missing": 0, "deletedInDraft": 0, "conflicts": 1}
    assert refused == [{"urn": "urn:b", "entityId": "B", "reason": "conflict",
                        "detail": "It already has steward."}]


def test_commits_are_named_by_the_operation_and_the_window():
    assert pj.window_message(_op("rename", to="steward"), None, 37, 120) == \
        "Bulk property: Rename owner → steward (37/120)"
    assert pj.window_message(_op("fillEmpty", value=1), None, 1, 1) == \
        "Bulk property: Fill owner where empty (1/1)"
    assert pj.window_message(_op("remove"), "Tidy up", 2, 3) == "Tidy up (2/3)"


def test_the_running_summary_adds_each_window_and_keeps_twenty_examples():
    summary = pj.empty_summary(3)
    rows = [{"urn": f"u{i}", "entityId": None, "reason": "missing", "detail": "x"} for i in range(15)]
    summary = pj._tally(summary, {"changed": 4, "missing": 15}, rows, "cmt_1")
    summary = pj._tally(summary, {"changed": 2, "conflicts": 10},
                        [{**r, "reason": "conflict"} for r in rows[:10]], None)
    summary = pj._tally(summary, {"unchanged": 1}, [], "cmt_3")
    assert (summary["changed"], summary["unchanged"], summary["missing"], summary["conflicts"]) == (6, 1, 15, 10)
    assert summary["refused"]["count"] == 25
    assert summary["refused"]["byReason"] == {"missing": 15, "conflict": 10}
    assert len(summary["refused"]["examples"]) == pj.REFUSED_EXAMPLES
    assert (summary["commits"], summary["firstCommitId"], summary["lastCommitId"]) == (2, "cmt_1", "cmt_3")
    assert summary["chunks"] == 3


class _Store:
    """An object store in memory."""

    def __init__(self):
        self.blobs = {}

    async def put_stream(self, key, chunks):
        self.blobs[key] = b"".join([c async for c in chunks])

    async def open_stream(self, key):
        yield self.blobs[key]

    async def stat(self, key):
        return type("Stat", (), {"exists": key in self.blobs})()

    async def delete(self, key):
        self.blobs.pop(key, None)


async def test_targets_are_kept_a_window_a_file(monkeypatch):
    monkeypatch.setattr(config, "PROPERTY_JOB_WINDOW", 2)
    store = _Store()
    assert await pj.write_targets(store, "vjob_1", ["a", "b", "c"]) == 2
    assert await pj.read_lines(store, pj.targets_key("vjob_1", 1)) == ["c"]
    assert pj.targets_key("vjob_1", 0) == "property-jobs/vjob_1/targets/0.ndjson"


async def test_the_refused_rows_read_as_csv_and_never_as_a_formula():
    store = _Store()
    await pj.write_lines(store, pj.refused_key("vjob_1", 1), [
        {"urn": "=HYPERLINK(1)", "entityId": "E1", "reason": "write_refused", "detail": "a, b"}])
    body = b"".join([c async for c in pj.refused_csv(store, "vjob_1", 2)]).decode()
    assert body.splitlines() == ["urn,entityId,reason,detail", "'=HYPERLINK(1),E1,write_refused,\"a, b\""]


# ── the request ───────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def V():
    from backend.app.api.v1.endpoints import versioning
    return versioning


def _request(V, op, target=None):
    return V.PropertyJobRequest.model_validate(
        {"op": op, "target": {"ids": ["urn:a", "urn:b"]} if target is None else target})


def test_an_op_says_everything_its_kind_needs(V):
    for bad in ({"kind": "rename", "key": "owner"}, {"kind": "copy", "key": "owner"},
                {"kind": "set", "key": "owner"}, {"kind": "fillEmpty", "key": "owner", "value": ""},
                {"kind": "fillEmpty", "key": "owner", "value": None},
                {"kind": "set", "key": "owner", "value": "x" * (64 * 1024)},
                {"kind": "set", "key": "", "value": 1}, {"kind": "set", "key": "k" * 129, "value": 1},
                {"kind": "drop", "key": "owner"}):
        with pytest.raises(ValidationError):
            _request(V, bad)
    op = _request(V, {"kind": "set", "key": "owner", "value": None, "to": "ignored"}).op
    assert op.wire() == {"kind": "set", "key": "owner", "onConflict": "skip", "value": None}


def test_a_target_is_ids_or_a_search_in_a_view(V):
    pred = {"kind": "hasProperty", "key": "owner"}
    for bad in ({}, {"ids": []}, {"ids": ["a"], "viewId": "v", "predicate": pred}, {"predicate": pred}):
        with pytest.raises(ValidationError):
            _request(V, {"kind": "remove", "key": "owner"}, bad)
    target = _request(V, {"kind": "remove", "key": "owner"},
                      {"viewId": "v1", "predicate": pred, "scopeMode": "data_source"}).target
    assert target.wire()["scopeMode"] == "data_source" and target.wire()["predicate"]["key"] == "owner"


def _code(V, op, target=None, rules=None):
    body = _request(V, op, target)
    refusal = V._check_property_job(body.op, body.target, rules)
    return refusal and refusal[:2]


def test_what_a_job_refuses_before_it_is_made(V):
    pred = {"kind": "hasProperty", "key": "owner"}
    assert _code(V, {"kind": "set", "key": "displayName", "value": "x"}) == (422, "reserved_key")
    assert _code(V, {"kind": "rename", "key": "owner", "to": "urn"}) == (422, "reserved_key")
    assert _code(V, {"kind": "copy", "key": "owner", "to": "owner"}) == (422, "same_key")
    assert _code(V, {"kind": "remove", "key": "owner"},
                 {"ids": [f"u{i}" for i in range(config.PROPERTY_JOB_MAX_IDS + 1)]}) == (422, "too_many_ids")
    assert _code(V, {"kind": "remove", "key": "owner"},
                 {"viewId": "v", "predicate": pred, "scopeMode": "visible"}) == (422, "visible_scope")
    for edges in ({"kind": "edges"}, {"kind": "group", "op": "and", "children": [{"kind": "edges"}]}):
        assert _code(V, {"kind": "remove", "key": "owner"},
                     {"viewId": "v", "predicate": edges}) == (422, "edge_predicate")
    assert _code(V, {"kind": "rename", "key": "owner", "to": "steward"}) is None


def test_one_value_for_a_unique_field_is_refused_on_more_than_one_entity(V):
    rules = OntologyRules(entity_types={"Dataset": EntityRule(unique_fields=frozenset({"code"}))})
    pred = {"kind": "hasProperty", "key": "code"}
    assert _code(V, {"kind": "set", "key": "code", "value": "X"}, rules=rules) == (422, "unique_field")
    assert _code(V, {"kind": "fillEmpty", "key": "code", "value": "X"},
                 {"viewId": "v", "predicate": pred}, rules=rules) == (422, "unique_field")
    assert _code(V, {"kind": "copy", "key": "owner", "to": "code"}, rules=rules) == (422, "unique_field")
    assert _code(V, {"kind": "set", "key": "code", "value": "X"}, {"ids": ["urn:a"]}, rules=rules) is None
    assert _code(V, {"kind": "remove", "key": "code"}, rules=rules) is None
    assert _code(V, {"kind": "set", "key": "code", "value": "X"}) is None          # no ontology


def test_what_publishing_would_refuse_is_warned_never_refused(V):
    from backend.app.services.versioning.ontology import FieldRule
    rules = OntologyRules(entity_types={"Dataset": EntityRule(fields={
        "tier": FieldRule(type="status", allowed=("gold", "silver"), name="Tier"),
        "owner": FieldRule(required=True, name="Owner"),
        "rows": FieldRule(type="number", name="Rows")})})

    def warned(op):
        body = _request(V, op)
        assert V._check_property_job(body.op, body.target, rules) is None      # never a refusal
        return [(w["code"], w["entityType"], w["field"]) for w in V._property_job_warnings(body.op, rules)]

    assert warned({"kind": "set", "key": "tier", "value": "bronze"}) == [("field_not_allowed", "Dataset", "tier")]
    assert warned({"kind": "fillEmpty", "key": "rows", "value": "many"}) == [("field_type", "Dataset", "rows")]
    assert warned({"kind": "set", "key": "tier", "value": "gold"}) == []
    assert warned({"kind": "remove", "key": "owner"}) == [("field_required", "Dataset", "owner")]
    assert warned({"kind": "rename", "key": "owner", "to": "steward"}) == [("field_required", "Dataset", "owner")]
    assert warned({"kind": "copy", "key": "label", "to": "tier"}) == [("field_checked", "Dataset", "tier")]
    assert warned({"kind": "set", "key": "other", "value": "x"}) == []
    assert V._property_job_warnings(_request(V, {"kind": "remove", "key": "owner"}).op, None) == []


def test_the_job_keeps_its_op_as_the_plan_reads_it(V):
    op = _request(V, {"kind": "rename", "key": "owner", "to": "steward", "onConflict": "overwrite",
                      "value": "ignored"}).op.wire()
    assert op == {"kind": "rename", "key": "owner", "to": "steward", "onConflict": "overwrite"}
    assert pj.plan_patch(op, {"owner": 1, "steward": 2}) == {"steward": 1, "owner": PROP_DELETE}
    json.dumps(op)


# ── the property-name budget ──────────────────────────────────────────────────
class _Falkor:
    def __init__(self, count, names=()):
        self.count, self.names = count, set(names)

    async def property_key_count(self):
        return self.count

    async def _registered_property_names(self, *, fresh=True):
        return self.names


async def _budget(monkeypatch, V, provider, op):
    from types import SimpleNamespace
    from backend.app.services.view_transfer import sources

    async def engine_for(*_a, **_kw):
        if provider is None:
            raise RuntimeError("no provider for this data source")
        return SimpleNamespace(provider=provider)
    monkeypatch.setattr(sources, "engine_for", engine_for)
    monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "1000")
    body = _request(V, op)
    return await V._property_name_budget(None, "ws1", {"data_source_id": "ds1"}, body.op)


async def test_a_new_key_near_the_name_ceiling_is_refused_and_past_the_budget_stored_raw(monkeypatch, V):
    rename = {"kind": "rename", "key": "owner", "to": "steward"}
    budget = await _budget(monkeypatch, V, _Falkor(10, {"owner"}), rename)
    assert budget == {"registered": 10, "nativeBudget": 1000, "ceiling": 65_534, "isNew": True, "verdict": "ok"}
    assert (await _budget(monkeypatch, V, _Falkor(5000), rename))["verdict"] == "raw"
    assert (await _budget(monkeypatch, V, _Falkor(65_534 - 256), rename))["verdict"] == "refused"
    # A name the graph holds already costs nothing, however full it is.
    held = await _budget(monkeypatch, V, _Falkor(65_534, {"steward"}), rename)
    assert (held["isNew"], held["verdict"]) == (False, "ok")
    # Through a write-through wrapper, to the store it wraps.
    from types import SimpleNamespace
    wrapped = await _budget(monkeypatch, V, SimpleNamespace(_inner=_Falkor(65_534 - 1)), rename)
    assert wrapped["verdict"] == "refused"
    removal = await _budget(monkeypatch, V, _Falkor(65_534), {"kind": "remove", "key": "owner"})
    assert (removal["isNew"], removal["verdict"]) == (False, "ok")


async def test_a_store_that_wont_say_never_refuses(monkeypatch, V):
    from types import SimpleNamespace
    set_op = {"kind": "set", "key": "tier", "value": 1}
    for provider in (None, SimpleNamespace(), _Falkor(None)):
        budget = await _budget(monkeypatch, V, provider, set_op)
        assert budget["verdict"] == "ok" and budget["registered"] is None and budget["isNew"] is None, budget


# ── a search target, resolved where the job runs ─────────────────────────────
def _search_hook(monkeypatch, *, refuse=None):
    """``_property_targets_from_job`` over a stub search: two requests to export, then a file of
    NDJSON lines cut mid-line."""
    import contextlib
    from types import SimpleNamespace

    from backend.app.api.v1.endpoints import graph as graph_ep
    from backend.app.db import engine as db_engine
    from backend.app.services import advanced_search_service, search_downloads
    from backend.app.services.view_transfer import sources
    from backend.common.models.search import SearchExportResult

    seen = {"exports": []}

    class Search:
        def __init__(self, engine, **kw):
            seen["can_read"] = kw["can_read_view"]

        async def export(self, request, *, principal, signing_key, run_context):
            if refuse:
                raise advanced_search_service.ValidationError(refuse)
            seen["exports"].append(request.session_id)
            if request.session_id is None:
                return SearchExportResult(session_id="s1", status="running", format="ndjson")
            token = search_downloads.mint_download_token("s1", "scope-h", principal, signing_key)
            return SearchExportResult(session_id="s1", status="complete", format="ndjson",
                                      download_token=token)

        async def open_export(self, session_id, scope_hash):
            seen["opened"] = (session_id, scope_hash)

            async def body():
                yield b'{"urn": "urn:a"}\n{"ur'
                yield b'n": "urn:b"}\n{"urn": null}\n{"urn": "urn:c"}'
            return SimpleNamespace(), body()

    @contextlib.asynccontextmanager
    async def session():
        async def commit():
            return None
        yield SimpleNamespace(commit=commit)

    async def engine_for(*_a, **_kw):
        return SimpleNamespace()

    async def data_version(_engine):
        return "dv1"

    monkeypatch.setattr(advanced_search_service, "AdvancedSearchService", Search)
    monkeypatch.setattr(db_engine, "get_async_session", session)
    monkeypatch.setattr(sources, "engine_for", engine_for)
    monkeypatch.setattr(graph_ep, "_search_data_version", data_version)
    monkeypatch.setattr(graph_ep, "_statement_admission", lambda _engine: None)
    return seen


_SEARCH_JOB = {"target": {"kind": "predicate", "viewId": "v1", "scopeMode": "view",
                          "predicate": {"kind": "hasProperty", "key": "owner"}},
               "workspaceId": "ws1", "dataSourceId": "ds1", "branchId": "b1", "actor": "alice"}


async def test_a_search_target_reads_every_match_of_its_export(monkeypatch, V):
    from types import SimpleNamespace
    seen = _search_hook(monkeypatch)
    assert [urn async for urn in V._property_targets_from_job(_SEARCH_JOB)] == ["urn:a", "urn:b", "urn:c"]
    assert seen["exports"] == [None, "s1"] and seen["opened"] == ("s1", "scope-h")
    view = SimpleNamespace(id="v1", workspace_id="ws1", data_source_id="ds1")
    assert await seen["can_read"](view)
    for other in ({"id": "v2"}, {"workspace_id": "ws2"}, {"data_source_id": "ds2"}):
        assert not await seen["can_read"](SimpleNamespace(**{**vars(view), **other}))


async def test_a_search_the_engine_refuses_stops_the_job_saying_why(monkeypatch, V):
    _search_hook(monkeypatch, refuse="view_not_found: view 'v1' not found")
    with pytest.raises(pj.PropertyJobStopped) as stopped:
        [urn async for urn in V._property_targets_from_job(_SEARCH_JOB)]
    assert stopped.value.code == "search_refused" and "view_not_found" in str(stopped.value)
