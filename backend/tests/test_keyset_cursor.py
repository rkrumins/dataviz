"""
Keyset pagination must not lose rows.

`displayName` is NOT unique — a real graph holds hundreds of children all called
"Accounts (Analytics)". The old keyset (`displayName > $cursor`) therefore SKIPPED
every row sharing the boundary row's name: a page ending mid-run of duplicates
made the next page start *after* the whole run. A node with 200 children paged out
as 197, silently, with no error anywhere.

A keyset is only correct on a unique sort key, so the cursor now carries the urn
as a tiebreaker and the queries order by (displayName, urn).
"""
import pytest

from backend.app.providers.falkordb_provider import (
    _decode_keyset_cursor,
    _encode_keyset_cursor,
    _keyset_sort_key,
)


class _Node:
    """Just enough of GraphNode for the sort key."""
    def __init__(self, display_name, urn):
        self.display_name = display_name
        self.urn = urn


# ── cursor codec ─────────────────────────────────────────────────────────

def test_cursor_round_trips_name_and_urn():
    cursor = _encode_keyset_cursor("Accounts (Analytics)", "urn:x:42")
    assert _decode_keyset_cursor(cursor) == ("Accounts (Analytics)", "urn:x:42")


def test_cursor_survives_names_that_would_break_a_delimiter():
    # Names carry colons, quotes, unicode — the cursor is opaque, not a join.
    name = 'a:b"c’d, e'
    cursor = _encode_keyset_cursor(name, "urn:x:1")
    assert _decode_keyset_cursor(cursor) == (name, "urn:x:1")


def test_legacy_cursor_decodes_as_name_only():
    # A client mid-pagination across a deploy must keep working, not 500.
    assert _decode_keyset_cursor("Accounts (Analytics)") == ("Accounts (Analytics)", None)


def test_missing_display_name_is_tolerated():
    cursor = _encode_keyset_cursor(None, "urn:x:7")
    assert _decode_keyset_cursor(cursor) == ("", "urn:x:7")


# ── the actual bug: a run of duplicates across a page boundary ───────────

def _page(rows, cursor, limit):
    """Simulate the SQL: WHERE (name > cName) OR (name = cName AND urn > cUrn),
    ORDER BY (name, urn), LIMIT n — i.e. exactly what the provider now emits."""
    ordered = sorted(rows, key=_keyset_sort_key)
    if cursor is None:
        return ordered[:limit]
    c_name, c_urn = _decode_keyset_cursor(cursor)
    remaining = [
        n for n in ordered
        if (n.display_name or "") > c_name
        or ((n.display_name or "") == c_name and (c_urn is None or n.urn > c_urn))
    ]
    return remaining[:limit]


def _page_all(rows, limit):
    seen, cursor = [], None
    # Runaway guard: a correct keyset always advances, so it can never need more
    # pages than there are rows.
    for _ in range(len(rows) + 2):
        page = _page(rows, cursor, limit)
        if not page:
            break
        seen.extend(page)
        if len(page) < limit:
            break
        cursor = _encode_keyset_cursor(page[-1].display_name, page[-1].urn)
    return seen


def test_pages_every_child_when_names_repeat():
    # 200 children, only 4 distinct names — the shape that lost 3 rows.
    rows = [
        _Node(f"Accounts (Analytics)" if i % 4 else f"Assets (Analytics)", f"urn:c:{i:04d}")
        for i in range(200)
    ]

    paged = _page_all(rows, limit=50)

    assert len(paged) == 200, "a page boundary inside a run of duplicates dropped rows"
    assert len({n.urn for n in paged}) == 200, "a row was returned twice"


def test_pages_every_child_when_every_name_is_identical():
    # The degenerate case: the keyset can only make progress via the tiebreaker.
    rows = [_Node("Accounts (Analytics)", f"urn:c:{i:04d}") for i in range(120)]

    paged = _page_all(rows, limit=50)

    assert [n.urn for n in paged] == [n.urn for n in sorted(rows, key=_keyset_sort_key)]


@pytest.mark.parametrize("limit", [1, 7, 50, 199, 200])
def test_page_size_never_changes_the_result_set(limit):
    rows = [_Node("Same Name", f"urn:c:{i:04d}") for i in range(200)]
    assert len(_page_all(rows, limit=limit)) == 200


# ── ordering ─────────────────────────────────────────────────────────────

def test_sort_key_is_total_and_puts_nulls_last():
    a = _Node(None, "urn:z")
    b = _Node("Alpha", "urn:b")
    c = _Node("Alpha", "urn:a")
    assert [n.urn for n in sorted([a, b, c], key=_keyset_sort_key)] == ["urn:a", "urn:b", "urn:z"]
