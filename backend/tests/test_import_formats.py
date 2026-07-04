"""Format adapters — streaming parse/serialize of ndjson + csv/tsv (no infra).

Adapters feed the ONE normalized row model: ``parse`` streams a byte iterator into raw column
dicts (reassembling records split across chunk boundaries — a 5M-row file is never buffered
whole); ``write`` serializes records back. The registry resolves a format name to its adapter.
Pure — runs under the per-file runner.
"""
import asyncio

from backend.app.services.versioning.import_export.formats import get_adapter


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

    # ---- unknown format raises ----
    try:
        get_adapter("parquet")
        assert False, "expected ValueError for unknown format"
    except ValueError:
        pass


def test_import_formats():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("import formats: OK")
