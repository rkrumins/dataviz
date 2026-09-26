"""Format adapters — streaming parse/serialize of ndjson + csv/tsv (no infra).

Adapters feed the ONE normalized row model: ``parse`` streams a byte iterator into raw column
dicts (reassembling records split across chunk boundaries — a 5M-row file is never buffered
whole); ``write`` serializes records back. The registry resolves a format name to its adapter,
after the import worker's content sniff corrects a declared ndjson/json. Parsing stays linear in
the file size. Pure — runs under the per-file runner.
"""
import asyncio
import csv
import io
import json
import logging
import shutil
import tempfile
import time

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning.import_export.formats import _lines, get_adapter
from backend.app.services.versioning.import_export.import_worker import ImportWorker, _sniff_format
from backend.app.services.versioning.import_export.resolve import _changed_props
from backend.app.services.versioning.import_export.rowmodel import cell_text, normalize


async def _achunks(*parts: bytes):
    for p in parts:
        yield p


async def _aiter(items):
    for x in items:
        yield x


async def _collect(aiter):
    return [x async for x in aiter]


async def _to_bytes(aiter):
    out = b""
    async for c in aiter:
        out += c
    return out


async def _run() -> None:
    # ---- ndjson: records reassembled across a chunk boundary ----
    nd = get_adapter("ndjson")
    recs = await _collect(nd.parse(_achunks(b'{"a": 1}\n{"b":', b' 2}\n')))
    assert recs == [{"a": 1}, {"b": 2}]
    out = await _to_bytes(nd.write(_aiter([{"a": 1}, {"b": 2}]), columns=["a", "b"]))
    assert out == b'{"a": 1}\n{"b": 2}\n'

    # ---- csv: header + rows -> dicts; quoted comma preserved ----
    cs = get_adapter("csv")
    recs = await _collect(cs.parse(_achunks(
        b'entity_id,urn,prop.owner\n', b'ent_1,urn:x,"a,b"\n')))
    assert recs == [{"entity_id": "ent_1", "urn": "urn:x", "prop.owner": "a,b"}]
    out = await _to_bytes(cs.write(
        _aiter([{"entity_id": "ent_1", "urn": "urn:x", "prop.owner": "alice"}]),
        columns=["entity_id", "urn", "prop.owner"]))
    assert out.decode().splitlines() == ["entity_id,urn,prop.owner", "ent_1,urn:x,alice"]

    # ---- tsv: tab-delimited variant ----
    tsv = get_adapter("tsv")
    recs = await _collect(tsv.parse(_achunks(b"a\tb\n1\t2\n")))
    assert recs == [{"a": "1", "b": "2"}]

    # ---- robustness: a UTF-8 BOM + CRLF + a Windows-1252 byte (0xe3) must NOT crash the parse
    #      (this is the "export -> edit in Excel -> import" reality that produced the
    #      "'utf-8' codec can't decode byte 0xe3" error). ----
    csv2 = get_adapter("csv")
    recs = await _collect(csv2.parse(_achunks(b"\xef\xbb\xbfa,b\r\n1,S\xe3o Paulo\r\n")))
    assert recs == [{"a": "1", "b": "São Paulo"}], recs   # BOM stripped, CRLF ok, cp1252 decoded

    # ---- json: a single array of records (reassembled across chunks) ----
    js = get_adapter("json")
    recs = await _collect(js.parse(_achunks(b'[{"a": 1},', b' {"b": 2}]')))
    assert recs == [{"a": 1}, {"b": 2}]
    out = await _to_bytes(js.write(_aiter([{"a": 1}, {"b": 2}]), columns=["a", "b"]))
    assert json.loads(out) == [{"a": 1}, {"b": 2}]

    # ---- unknown format raises ----
    try:
        get_adapter("parquet")
        assert False, "expected ValueError for unknown format"
    except ValueError:
        pass

    # ---- csv: a quoted cell holding a newline (and an empty line) + a doubled quote is ONE record
    #      with the exact value, even with a chunk boundary inside the cell — the csv writer emits
    #      such cells, and a per-line parse used to split them into two broken rows ----
    recs = await _collect(get_adapter("csv").parse(_achunks(
        b'entity_id,prop.note\nent_1,"He said ""hi""\n', b'\nand left"\nent_2,plain\n')))
    assert recs == [{"entity_id": "ent_1", "prop.note": 'He said "hi"\n\nand left'},
                    {"entity_id": "ent_2", "prop.note": "plain"}], recs

    # ---- csv: a quote INSIDE an unquoted cell is literal (only one at the start of a cell opens a
    #      quoted cell), so an odd number of them (5" screen) keeps the record to its line; an
    #      escaped quote ("") in a quoted cell, even right before a line break, doesn't close it;
    #      in tsv a quoted cell opens after a tab ----
    recs = await _collect(get_adapter("csv").parse(_achunks(
        b'entity_id,prop.size,prop.note\n'
        b'ent_1,5" screen,plain\n'
        b'ent_2,7,"a ""b"" c\nd ""e""\nf"\n'
        b'ent_3,x"y"z,last\n')))
    assert recs == [{"entity_id": "ent_1", "prop.size": '5" screen', "prop.note": "plain"},
                    {"entity_id": "ent_2", "prop.size": "7", "prop.note": 'a "b" c\nd "e"\nf'},
                    {"entity_id": "ent_3", "prop.size": 'x"y"z', "prop.note": "last"}], recs
    recs = await _collect(get_adapter("tsv").parse(_achunks(b'a\tb\n1\t"x\ny"\n2\t3"\n')))
    assert recs == [{"a": "1", "b": "x\ny"}, {"a": "2", "b": '3"'}], recs

    # ---- list properties round-trip through csv/tsv: cell_text renders a flat list as JSON (the
    #      writers' job) and the parse reads it back as the SAME list, so re-importing an unchanged
    #      export changes nothing (str() gave "['a', 'b']", re-imported as a string "update").
    #      A bracketed non-JSON string stays a string; scalars keep their str rendering. ----
    stored = {"tags": ["a", "b"], "mixed": [1, 2.5, True, None, 'x, "y"\nz'], "label": "[draft]",
              "n": 5}
    for fmt, delim in (("csv", ","), ("tsv", "\t")):
        buf = io.StringIO()
        out = csv.writer(buf, delimiter=delim, lineterminator="\n")
        out.writerow(["entity_id", *(f"prop.{k}" for k in stored)])
        out.writerow(["ent_1", *(cell_text(v) for v in stored.values())])
        recs = await _collect(get_adapter(fmt).parse(_achunks(buf.getvalue().encode())))
        assert recs == [{"entity_id": "ent_1", "prop.tags": ["a", "b"],
                         "prop.mixed": [1, 2.5, True, None, 'x, "y"\nz'],
                         "prop.label": "[draft]", "prop.n": "5"}], (fmt, recs)
        assert _changed_props(normalize(recs[0], "node")["properties"], stored) == {}, fmt

    # ---- ndjson/json values are already typed: a "[1,2]" STRING stays a string there ----
    recs = await _collect(get_adapter("ndjson").parse(_achunks(
        b'{"prop.s": "[1,2]", "prop.l": [1, 2]}\n')))
    assert recs == [{"prop.s": "[1,2]", "prop.l": [1, 2]}], recs
    recs = await _collect(get_adapter("json").parse(_achunks(b'[{"prop.s": "[1,2]"}]')))
    assert recs == [{"prop.s": "[1,2]"}], recs


async def _worker_parse(declared: str, body: bytes):
    """Drive the real ``ImportWorker._parse`` over a LocalFs store, capturing the staged rows
    instead of flushing them to Postgres. Returns ``(row count, normalized rows)``."""
    root = tempfile.mkdtemp(prefix="import-sniff-")
    try:
        store = LocalFsObjectStore(root)
        await store.put_stream("source", _achunks(body))
        worker = ImportWorker(versioning=None, store=store)
        staged = []

        async def _capture(batch):
            staged.extend(batch)
        worker._flush = _capture
        count = await worker._parse("job_1", "source", declared)
        return count, [row["raw"] for row in staged]
    finally:
        shutil.rmtree(root, ignore_errors=True)


async def _run_sniff() -> None:
    # ---- the sniff: for a declared ndjson/json, the first non-whitespace byte (after an optional
    #      BOM) decides — '[' is a JSON array, '{' is json-lines; None keeps the declaration ----
    assert _sniff_format("ndjson", b'[{"kind": "node"}]') == "json"
    assert _sniff_format("json", b'{"kind": "node"}\n{"kind": "edge"}\n') == "ndjson"
    assert _sniff_format("NDJSON", b"\xef\xbb\xbf \r\n\t[") == "json"
    assert _sniff_format("json", b"[{}]") is None and _sniff_format("ndjson", b"{}") is None
    assert _sniff_format("ndjson", b"") is None and _sniff_format("json", b"kind,urn") is None
    for declared in ("csv", "tsv", "xlsx"):                  # never second-guessed
        assert _sniff_format(declared, b"[{}]") is None and _sniff_format(declared, b"{}") is None

    # ---- wired into the worker: a JSON array declared ndjson imports via the json adapter and
    #      json-lines declared json via the ndjson adapter; the sniffed first chunk still reaches
    #      the parser (the first record is staged) ----
    records = [{"kind": "node", "urn": "urn:a", "displayName": "A"},
               {"kind": "node", "urn": "urn:b", "displayName": "B"}]
    array_body = b"\xef\xbb\xbf\n" + json.dumps(records).encode()
    lines_body = ("\n".join(json.dumps(r) for r in records) + "\n").encode()
    for declared, body in (("ndjson", array_body), ("json", lines_body)):
        count, rows = await _worker_parse(declared, body)
        assert count == 2 and [r["urn"] for r in rows] == ["urn:a", "urn:b"], (declared, rows)


async def _run_scale() -> None:
    # ---- _lines: a large multi-chunk file with a BOM + CRLF endings yields exactly the written
    #      lines (an empty one included) — whatever the chunk boundaries split (the BOM, a CRLF
    #      pair, a multi-byte UTF-8 char) — plus the per-line cp1252 fallback and an unterminated
    #      last line ----
    lines = [f'{{"i": {i}, "city": "São Paulo", "pad": "{"x" * (i % 97)}"}}' for i in range(40_000)]
    lines[7] = ""
    data = b"\xef\xbb\xbf" + b"".join(line.encode() + b"\r\n" for line in lines) + b"last,S\xe3o"
    cuts = sorted({0, 1, data.index(b"\r\n", 1000) + 1, data.index("ã".encode(), 5000) + 1,
                   *range(0, len(data), 7919)})
    chunks = [data[a:b] for a, b in zip(cuts, cuts[1:] + [len(data)])]
    assert await _collect(_lines(_achunks(*chunks))) == lines + ["last,São"]

    # ---- ...and linear: ~20 MiB of ndjson in the object store's 1 MiB reads parses well under 2 s
    #      (re-splitting the whole remaining buffer per line was quadratic: seconds at 20 MiB) ----
    line = json.dumps({"kind": "node", "urn": "urn:x", "displayName": "d", "pad": "p" * 20}).encode()
    blob = (line + b"\n") * ((20 << 20) // (len(line) + 1))
    mib = 1 << 20
    started = time.perf_counter()
    count = 0
    async for _ in get_adapter("ndjson").parse(
            _achunks(*(blob[i:i + mib] for i in range(0, len(blob), mib)))):
        count += 1
    elapsed = time.perf_counter() - started
    assert count == blob.count(b"\n") and elapsed < 2.0, (count, elapsed)

    # ---- json: a large array fed in many small chunks is reassembled whole, in linear time
    #      (`bytes +=` per chunk re-copied everything so far: seconds for this input) ----
    records = [{"kind": "node", "urn": f"urn:{i}"} for i in range(200_000)]
    blob = json.dumps(records).encode()
    started = time.perf_counter()
    got = await _collect(get_adapter("json").parse(
        _achunks(*(blob[i:i + 256] for i in range(0, len(blob), 256)))))
    elapsed = time.perf_counter() - started
    assert got == records and elapsed < 2.0, (len(got), elapsed)


def test_import_formats():
    asyncio.run(_run())


def test_import_format_sniff(caplog):
    with caplog.at_level(logging.INFO, logger=ImportWorker.__module__):
        asyncio.run(_run_sniff())
    assert "overridden to 'json'" in caplog.text and "overridden to 'ndjson'" in caplog.text


def test_import_formats_scale():
    asyncio.run(_run_scale())


if __name__ == "__main__":
    asyncio.run(_run())
    asyncio.run(_run_sniff())
    asyncio.run(_run_scale())
    print("import formats: OK")
