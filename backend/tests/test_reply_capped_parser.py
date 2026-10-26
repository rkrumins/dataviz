"""The reply cap on native FalkorDB queries: the parser counts what it reads
off the socket for each reply and stops past the cap — so a query asking
for millions of nodes costs the API process at most the cap — and the count
starts again with every reply.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from redis._parsers.encoders import Encoder

from backend.app.providers.falkordb_native import ReplyTooLarge, capped_parser
from backend.common.interfaces.native_query import NativeQueryTooLarge


def parser_over(data: bytes, cap: int, read_size: int = 16):
    stream = asyncio.StreamReader()
    stream.feed_data(data)
    parser = capped_parser(cap)(socket_read_size=read_size)
    parser.on_connect(SimpleNamespace(_reader=stream, encoder=Encoder("utf-8", "strict", True)))
    return parser


def bulk(text: str) -> bytes:
    return f"${len(text)}\r\n{text}\r\n".encode()


async def test_a_reply_under_the_cap_reads_as_usual():
    parser = parser_over(b"*2\r\n" + bulk("abc") + bulk("def"), cap=100)
    assert await parser.read_response() == ["abc", "def"]


async def test_a_reply_over_the_cap_is_refused_before_it_is_all_read():
    data = b"*1\r\n" + bulk("x" * 10_000)
    parser = parser_over(data, cap=1_000, read_size=256)
    with pytest.raises(ReplyTooLarge) as refused:
        await parser.read_response()
    assert isinstance(refused.value, NativeQueryTooLarge)
    assert "larger than 1,000 bytes" in str(refused.value)
    # It stopped within one read of the cap, leaving the rest unread.
    assert len(parser._stream._buffer) > len(data) - 1_000 - 256 - 1


async def test_the_count_starts_again_with_every_reply():
    reply = b"*1\r\n" + bulk("y" * 50)
    parser = parser_over(reply * 3, cap=100)
    for _ in range(3):
        assert await parser.read_response() == ["y" * 50]


async def test_one_parser_class_per_cap():
    assert capped_parser(1 << 20) is capped_parser(1 << 20)
    assert capped_parser(1 << 20).cap == 1 << 20
    assert capped_parser(1 << 21) is not capped_parser(1 << 20)
