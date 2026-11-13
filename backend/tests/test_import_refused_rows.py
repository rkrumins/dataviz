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
from backend.app.services.versioning.import_export.resolve import CODES, FIXES
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
        {"rowIndex": 7, "kind": "node", "label": "refunds", "code": "invalid_type", "reason": "x" * 300}],
        "fixes": {"no_key": FIXES["no_key"], "invalid_type": FIXES["invalid_type"]},
        "byKind": {"node": 2}}
    assert tally_refused(first, [{"_row_index": 9, "status": "updated"}], {}) is first, "no refusals"
    many = tally_refused(first, [_refusal(10 + i, "no_key") for i in range(40)], {})
    assert (many["total"], many["byCode"]["no_key"]) == (42, 41)
    assert len(many["rows"]) == REFUSED_EXAMPLES and many["rows"][:2] == first["rows"], "the first ones"
    assert tally_refused(None, [_refusal(1, None)], {})["byCode"] == {"invalid_row": 1}


def test_every_reason_says_what_to_do_about_it():
    assert set(FIXES) == set(CODES) | {NOT_A_RECORD}
    assert all(fix.endswith(".") and len(fix) < 300 for fix in FIXES.values())


def test_records_neither_a_node_nor_an_edge_are_counted_once():
    report = with_not_a_record({"total": 1, "byCode": {"no_key": 1}, "rows": []}, 3)
    assert (report["total"], report["byCode"]) == (4, {"no_key": 1, NOT_A_RECORD: 3})
    assert report["fixes"] == {"no_key": FIXES["no_key"], NOT_A_RECORD: FIXES[NOT_A_RECORD]}
    assert with_not_a_record(report, 3) == report
    assert with_not_a_record(None, 0) is None


def test_a_digest_names_the_reasons_by_count_then_the_first_rows():
    report = tally_refused(None, [_refusal(4, "invalid_type", "Dashboard isn't a type here"),
                                  _refusal(8, "no_key", "give it a urn"), _refusal(9, "no_key")],
                           {4: "sales"})
    digest = refused_digest(report)
    assert digest.startswith(" Refused: 2 no_key, 1 invalid_type.")
    assert "rowIndex 4 (sales): invalid_type — Dashboard isn't a type here" in digest
    assert f"To fix no_key: {FIXES['no_key']}" in digest and f"To fix invalid_type: {FIXES['invalid_type']}" in digest
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
    assert message.startswith("Nothing was deleted: 2 node row(s) of the file were refused"), message
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


# ── Where a refused row is, in every format ─────────────────────────────────────────


async def _chunks(data: bytes):
    yield data


async def _positions(fmt: str, data: bytes, *, pages: bool = False):
    from backend.app.services.versioning.import_export.formats import AT, get_adapter
    adapter = get_adapter(fmt)
    if pages:
        return [r.get(AT) for page in [p async for p in adapter.parse_pages(_chunks(data), 2, at=True)]
                for r in page]
    return [r.get(AT) async for r in adapter.parse(_chunks(data), at=True)]


async def test_an_ndjson_record_is_where_its_line_is():
    data = b'{"kind": "node", "urn": "a"}\n\n{"kind": "node", "urn": "b"}\r\n{"kind": "edge"}\n'
    want = [{"line": 1}, {"line": 3}, {"line": 4}]
    assert await _positions("ndjson", data) == want
    assert await _positions("ndjson", data, pages=True) == want, "a page at a time too"


@pytest.mark.parametrize("fmt, sep", [("csv", ","), ("tsv", "\t")])
async def test_a_delimited_record_is_where_its_first_line_is(fmt, sep):
    data = (f'kind{sep}urn{sep}description\n'
            f'node{sep}a{sep}"two\nlines"\n'
            f'node{sep}b{sep}x\n'
            f'\n'
            f'{sep}{sep}\n'
            f'node{sep}c{sep}y\n').encode()
    assert await _positions(fmt, data) == [{"line": 2}, {"line": 4}, {"line": 7}]


async def test_a_json_record_is_where_its_item_is():
    data = b'[{"kind": "node", "urn": "a"}, "not a record", {"kind": "node", "urn": "b"}]'
    assert await _positions("json", data) == [{"item": 0}, {"item": 2}]


async def test_an_excel_record_is_where_its_sheet_and_row_are():
    import io

    import openpyxl
    wb = openpyxl.Workbook()
    nodes = wb.active
    nodes.title = "Nodes"
    for row in (["urn", "entityType"], ["a", "Table"], [None, None], ["b", "Table"]):
        nodes.append(row)
    edges = wb.create_sheet("Edges")
    for row in (["edgeType", "sourceUrn", "targetUrn"], ["FLOWS_TO", "a", "b"]):
        edges.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    assert await _positions("xlsx", buf.getvalue()) == [
        {"sheet": "Nodes", "row": 2}, {"sheet": "Nodes", "row": 4}, {"sheet": "Edges", "row": 2}]


async def test_a_reader_not_asked_adds_nothing():
    from backend.app.services.versioning.import_export.formats import AT, get_adapter
    records = [r async for r in get_adapter("ndjson").parse(_chunks(b'{"kind": "node", "urn": "a"}\n'))]
    assert AT not in records[0]


def test_where_a_record_is_goes_on_its_row_and_never_into_its_data():
    from backend.app.services.versioning.import_export.formats import AT
    (kind, row), = import_worker._normalize_page(
        [{"kind": "node", "urn": "a", "entityType": "Table", AT: {"line": 7}}])[0]
    assert (kind, row["_at"]) == ("node", {"line": 7})
    assert AT not in row and AT not in (row.get("properties") or {}), "not a column, not a property"


def test_a_refused_row_says_where_it_is_as_its_file_shows_it():
    report = tally_refused(None, [_refusal(1, "no_key"), _refusal(2, "no_key"), _refusal(3, "no_key"),
                                  _refusal(4, "no_key")],
                           {}, {1: {"line": 3}, 2: {"sheet": "Edges", "row": 7}, 3: {"item": 0}})
    assert [import_worker.where_text(r) for r in report["rows"]] == [
        "line 3", "Edges row 7", "item 0", "rowIndex 4"]
    assert "line 3: no_key" in refused_digest(report)
