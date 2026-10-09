"""A package seed reads its data as lines with BYTE OFFSETS, and resumes at one.

The data part of a view package is deflated NDJSON, so there is no seeking: a seed window's cursor
is the byte where its next line starts (``nodes:<byte>``), and a resumed run inflates from the top
and drops everything before it. What must hold for that to be exact:

* every line comes back with the offset it starts at, however the stream happens to be chunked;
* a stream opened at a cursor yields exactly the lines a single pass yields from there — so a run
  that stops after any window and resumes from its cursor reads every line once;
* a last line with no newline is still a line, and the cursor then stands at the end of the data;
* an error the source raises at its end (the checksum of an upload changed since it was checked)
  reaches the reader, rather than the copy quietly ending early.

Also: a run keeps ONE stream open across its windows, and opens another only when the cursor is
not where that stream stands (the next phase starts elsewhere) — closing the old one, which holds a
spooled copy of the upload.
"""
import asyncio
import random
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import package_seed
from backend.app.services.versioning.package_seed import LineStream

DATA = (b'{"kind":"node","entity_id":"a"}\n'
        b'{"kind":"node","entity_id":"bb"}\r\n'
        b"\n"
        b'{"kind":"edge","entity_id":"e1"}\n'
        b'{"kind":"edge","entity_id":"e2"}')                 # no final newline
FIRST_EDGE = DATA.index(b'{"kind":"edge"')


async def _chunks(data: bytes, sizes):
    i = 0
    for size in sizes:
        if i >= len(data):
            break
        yield data[i:i + size]
        i += size
    if i < len(data):
        yield data[i:]


def _sizes(seed):
    rng = random.Random(seed)
    return [rng.randint(1, 9) for _ in range(len(DATA))]


async def _all(stream, n=3):
    out = []
    while True:
        lines = await stream.read(n)
        if not lines:
            return out
        out.extend(lines)


@pytest.mark.parametrize("sizes", [[1] * len(DATA), [len(DATA)], _sizes(1), _sizes(2), [7, 50, 3]])
def test_every_line_comes_back_with_the_offset_it_starts_at(sizes):
    lines = asyncio.run(_all(LineStream(_chunks(DATA, sizes))))
    assert [line for _at, line in lines] == DATA.split(b"\n")
    for at, line in lines:
        assert DATA[at:at + len(line)] == line


@pytest.mark.parametrize("window", [1, 2, 4])
def test_resuming_at_any_cursor_reads_every_line_once(window):
    async def run():
        whole = await _all(LineStream(_chunks(DATA, _sizes(3))))
        resumed, at = [], 0
        while True:
            # A new stream per window — as a run that stopped after every window would read it.
            stream = LineStream(_chunks(DATA, _sizes(at)), at)
            lines = await stream.read(window)
            if not lines:
                assert stream.eof and stream.at == len(DATA)
                return whole, resumed
            resumed.extend(lines)
            at = stream.at
    whole, resumed = asyncio.run(run())
    assert resumed == whole


def test_the_cursor_ends_at_the_end_of_the_data():
    async def run():
        stream = LineStream(_chunks(DATA, [4]))
        await _all(stream, n=100)
        again = LineStream(_chunks(DATA, [4]), stream.at)
        return stream.at, await again.read(10)
    at, more = asyncio.run(run())
    assert at == len(DATA) and more == []


def test_an_error_at_the_end_of_the_source_reaches_the_reader():
    async def damaged():
        yield DATA
        raise ValueError("The package's data isn't what was checked when it was uploaded.")

    async def run():
        stream = LineStream(damaged())
        with pytest.raises(ValueError, match="isn't what was checked"):
            await stream.read(100)
        return stream
    assert asyncio.run(run()).broken, "never read on as if the data had ended"


def test_a_broken_stream_is_never_continued(monkeypatch):
    """A source that raised is finished: continuing it would read as the end of the data, and a
    retried window would end its phase early. The next window opens the data again."""
    calls = []

    def open_source(_store, _uri):
        async def gen():
            calls.append(1)
            if len(calls) == 1:
                raise ConnectionError("the store went away")
            yield DATA
        return gen()

    monkeypatch.setattr("backend.app.services.versioning.import_export.uploads.open_source",
                        open_source)
    run = SimpleNamespace(_object_store=lambda: object())
    ctx = SimpleNamespace(stream=None)

    async def go():
        stream = await package_seed._stream_at(run, ctx, "up/upload.json", 0)
        with pytest.raises(ConnectionError):
            await stream.read(2)
        retried = await package_seed._stream_at(run, ctx, "up/upload.json", 0)
        assert retried is not stream
        return await retried.read(2)
    assert [line for _at, line in asyncio.run(go())] == DATA.split(b"\n")[:2]


def test_a_run_keeps_its_stream_and_reopens_only_elsewhere(monkeypatch):
    opened, closed = [], []

    def open_source(_store, uri):
        async def gen():
            try:
                yield DATA
            finally:
                closed.append(uri)
        opened.append(uri)
        return gen()

    monkeypatch.setattr("backend.app.services.versioning.import_export.uploads.open_source",
                        open_source)
    run = SimpleNamespace(_object_store=lambda: object())
    ctx = SimpleNamespace(stream=None)

    async def go():
        first = await package_seed._stream_at(run, ctx, "up/upload.json", 0)
        await first.read(2)
        same = await package_seed._stream_at(run, ctx, "up/upload.json", first.at)
        assert same is first, "the next window continues the open stream"
        await first.read(2)                              # past the first edge, mid-stream
        edges = await package_seed._stream_at(run, ctx, "up/upload.json", FIRST_EDGE)
        assert edges is not first and ctx.stream is edges
        return await edges.read(10)
    lines = asyncio.run(go())
    assert opened == ["up/upload.json", "up/upload.json"] and closed[:1] == ["up/upload.json"]
    assert [line for _at, line in lines] == DATA[FIRST_EDGE:].split(b"\n")
    assert lines[0][0] == FIRST_EDGE
