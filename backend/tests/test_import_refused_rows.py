"""Refused rows: what an import reports of them, and how many it may go on without.

Pins: ``maxRefusedRows`` is 0 (hold on any), a count, a share of the file's rows, or -1 (any), and
anything else says what it may be; the platform's default holds on any when it isn't a limit, rather
than stop every import. Every import reports its refused rows as it goes, a window at a time — how
many, for each reason, and the first ones with what each said — so a resumed import counts each row
once and nothing reads the job's rows again to report them. A replace past its budget deletes
nothing and says why, naming the reasons and the first rows; within it, it goes on to its guard and
its deletes, and its summary keeps the report. Postgres: integration/test_import_refused_rows_flow.py.
"""
import pytest

from backend.app.services.versioning import config
from backend.app.services.versioning.import_export import import_worker
from backend.app.services.versioning.import_export.import_worker import (
    NOT_A_RECORD, REFUSED_EXAMPLES, ImportWorker, refused_budget, refused_digest, tally_refused,
    with_not_a_record, within_budget)


@pytest.mark.parametrize("value", ["0", "100", "0.5%", "100%", "-1", " 7 "])
def test_a_budget_is_a_count_a_share_or_any(value):
    assert refused_budget(value) == value.strip()


@pytest.mark.parametrize("value", ["", "lots", "-2", "101%", "1.5", "1.2.3%", "%"])
def test_anything_else_says_what_a_budget_may_be(value):
    with pytest.raises(ValueError, match="a count such as 100, a share of the file's rows such as 0.5%"):
        refused_budget(value)


def test_the_platforms_budget_holds_on_any_refused_row_when_it_isnt_a_limit(monkeypatch):
    monkeypatch.setattr(config, "IMPORT_MAX_REFUSED_ROWS", "250")
    assert refused_budget(None) == "250"
    monkeypatch.setattr(config, "IMPORT_MAX_REFUSED_ROWS", "plenty")
    assert refused_budget(None) == "0"


@pytest.mark.parametrize("budget, refused, rows, within", [
    ("0", 0, 10, True), ("0", 1, 10, False), ("1", 1, 10, True), ("1", 2, 10, False),
    ("10%", 1, 10, True), ("10%", 2, 10, False), ("0.5%", 5, 1000, True), ("0.5%", 6, 1000, False),
    ("-1", 10 ** 9, 1, True),
])
def test_refused_rows_are_within_a_budget_or_past_it(budget, refused, rows, within):
    assert within_budget(budget, refused, rows) is within


def _refusal(index, code, reason="why", kind="node"):
    return {"_row_index": index, "kind": kind, "status": "invalid", "code": code, "reasons": [reason]}


def test_the_report_counts_each_reason_and_names_the_first_rows_across_windows():
    first = tally_refused(None, [_refusal(3, "no_key", "give it a urn"),
                                 {"_row_index": 4, "status": "new"},
                                 _refusal(7, "invalid_type", "x" * 1000)], {3: "orders", 7: "refunds"})
    assert first == {"total": 2, "byCode": {"no_key": 1, "invalid_type": 1}, "rows": [
        {"rowIndex": 3, "kind": "node", "label": "orders", "code": "no_key", "reason": "give it a urn"},
        {"rowIndex": 7, "kind": "node", "label": "refunds", "code": "invalid_type", "reason": "x" * 300}]}
    assert tally_refused(first, [{"_row_index": 9, "status": "updated"}], {}) is first, "no refusals"
    many = tally_refused(first, [_refusal(10 + i, "no_key") for i in range(40)], {})
    assert (many["total"], many["byCode"]["no_key"]) == (42, 41)
    assert len(many["rows"]) == REFUSED_EXAMPLES and many["rows"][:2] == first["rows"], "the first ones"
    assert tally_refused(None, [_refusal(1, None)], {})["byCode"] == {"invalid_row": 1}


def test_records_neither_a_node_nor_an_edge_are_counted_once():
    report = with_not_a_record({"total": 1, "byCode": {"no_key": 1}, "rows": []}, 3)
    assert (report["total"], report["byCode"]) == (4, {"no_key": 1, NOT_A_RECORD: 3})
    assert with_not_a_record(report, 3) == report
    assert with_not_a_record(None, 0) is None


def test_a_digest_names_the_reasons_by_count_then_the_first_rows():
    report = tally_refused(None, [_refusal(4, "invalid_type", "Dashboard isn't a type here"),
                                  _refusal(8, "no_key", "give it a urn"), _refusal(9, "no_key")],
                           {4: "sales"})
    digest = refused_digest(report)
    assert digest.startswith(" Refused: 2 no_key, 1 invalid_type.")
    assert "rowIndex 4 (sales): invalid_type — Dashboard isn't a type here" in digest
    assert refused_digest(None) == ""


# ── The worker's hold ───────────────────────────────────────────────────────────


class _Lease:
    async def retry_transient(self, fn, never=()):
        return await fn()


def _replace(monkeypatch, summary, budget):
    """A replace whose windows are done, with ``summary`` on its job, under ``budget``."""
    worker = ImportWorker(versioning=None, store=None)
    worker._lease, worker._refused_budget = _Lease(), budget
    calls = []

    async def open_snapshot(**_kw):
        return object()

    async def position(_job_id):
        return import_worker._Position("edge:9", dict(summary), 0, 10)

    async def no_more(*_a):
        return False

    async def guard(_job_id, _snap):
        calls.append("guard")

    async def delete_absent(*_a):
        calls.append("delete")

    monkeypatch.setattr(import_worker, "open_snapshot", open_snapshot)
    worker._position, worker._next_window = position, no_more
    worker._guard_replace, worker._delete_absent = guard, delete_absent
    return worker, calls


_REPORT = tally_refused(None, [_refusal(4, "invalid_type", "Dashboard isn't a type here"),
                               _refusal(8, "no_key", "give it a urn")], {4: "sales"})


async def test_a_replace_past_its_budget_deletes_nothing_and_says_which_rows_and_why(monkeypatch):
    worker, calls = _replace(monkeypatch, {"new": 8, "invalid": 2, "refused": _REPORT}, "1")
    with pytest.raises(import_worker.ReplaceRowsRefused) as refused:
        await worker._resolve_and_build("vjob_1", "g1", "br1", "u", "replace")
    message = str(refused.value)
    assert message.startswith("Nothing was deleted: 2 row(s) of the file were refused")
    assert "1 invalid_type, 1 no_key" in message and "rowIndex 4 (sales): invalid_type" in message
    assert "maxRefusedRows" in message and "GET …/imports/vjob_1/preview" in message
    assert len(message) < 2000, "the job's errorMessage keeps all of it"
    assert calls == []


@pytest.mark.parametrize("budget", ["2", "20%", "-1"])
async def test_a_replace_within_its_budget_goes_on_and_keeps_its_report(monkeypatch, budget):
    worker, calls = _replace(monkeypatch, {"new": 8, "invalid": 2, "refused": _REPORT}, budget)
    tallies = await worker._resolve_and_build("vjob_1", "g1", "br1", "u", "replace")
    assert calls == ["guard", "delete"]
    assert tallies["invalid"] == 2 and tallies["refused"] == _REPORT


async def test_records_neither_a_node_nor_an_edge_go_on_within_the_budget(monkeypatch):
    worker, calls = _replace(monkeypatch, {"new": 9, "skipped": 1}, "-1")
    tallies = await worker._resolve_and_build("vjob_1", "g1", "br1", "u", "replace")
    assert calls == ["guard", "delete"]
    assert tallies["refused"]["byCode"] == {NOT_A_RECORD: 1} and tallies["skipped"] == 1
    worker, calls = _replace(monkeypatch, {"new": 9, "skipped": 1}, "0")
    with pytest.raises(import_worker.ReplaceRowsRefused, match="maxRefusedRows"):
        await worker._resolve_and_build("vjob_1", "g1", "br1", "u", "replace")
