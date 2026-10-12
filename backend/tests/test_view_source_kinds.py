"""Versioned / external classification of views (services/view_source_kinds).

The versioned set comes from the graphver store, which the SQLite harness never
creates, so every test stubs the lookup the way production code reaches it —
through the ``versioned_sources`` module attribute.
"""
import pytest

from backend.app.services import view_source_kinds
from backend.app.services.versioned_sources import VersionedLookupUnavailable
from backend.app.services.view_source_kinds import SourceKindSets, SourceKindUnavailable

_LOOKUP = "backend.app.services.versioned_sources.versioned_data_source_ids"


@pytest.fixture(autouse=True)
def _fresh():
    view_source_kinds.reset()
    yield
    view_source_kinds.reset()


def _stub(monkeypatch, *, returns=frozenset(), raises=None):
    """Install a fake lookup; returns the list of kwargs it was called with."""
    calls = []

    async def _fake(**kwargs):
        calls.append(kwargs)
        if raises is not None:
            raise raises
        return frozenset(returns)

    monkeypatch.setattr(_LOOKUP, _fake)
    return calls


SETS = SourceKindSets(
    versioned_ds=frozenset({"ds_v", "ds_v_default"}),
    ws_default={"ws_v": "ds_v_default", "ws_x": "ds_x_default"},
)


@pytest.mark.parametrize("ds_id, ws_id, expected", [
    ("ds_v", "ws_x", "versioned"),             # its own source wins over the default
    ("ds_other", "ws_v", "external"),          # ... both ways
    (None, "ws_v", "versioned"),               # NULL: the workspace default's kind
    (None, "ws_x", "external"),
    (None, "ws_no_sources", None),             # reads no data at all: neither kind
    (None, None, None),
])
def test_kind_for(ds_id, ws_id, expected):
    assert SETS.kind_for(ds_id, ws_id) == expected


def test_workspace_sets_split_by_the_default_sources_kind():
    assert SETS.versioned_ws == {"ws_v"}
    assert SETS.external_ws == {"ws_x"}


async def test_the_module_attribute_patch_is_what_answers(db_session, monkeypatch):
    calls = _stub(monkeypatch, returns={"ds_v"})
    sets = await view_source_kinds.load_sets(db_session, required=True)
    assert sets.versioned_ds == {"ds_v"}
    # A user-facing filter must see a newly versioned source within a minute.
    assert calls == [{"ttl_secs": 60}]


@pytest.mark.parametrize("error", [
    VersionedLookupUnavailable("graphver down"),
    RuntimeError("anything else"),
])
async def test_a_failed_lookup_is_unknown_or_unavailable(db_session, monkeypatch, error):
    _stub(monkeypatch, raises=error)
    assert await view_source_kinds.load_sets(db_session, required=False) is None
    view_source_kinds.reset()
    with pytest.raises(SourceKindUnavailable):
        await view_source_kinds.load_sets(db_session, required=True)


async def test_a_failure_is_not_retried_for_thirty_seconds(db_session, monkeypatch):
    calls = _stub(monkeypatch, raises=VersionedLookupUnavailable("graphver down"))
    assert await view_source_kinds.load_sets(db_session, required=False) is None
    assert await view_source_kinds.load_sets(db_session, required=False) is None
    with pytest.raises(SourceKindUnavailable):
        await view_source_kinds.load_sets(db_session, required=True)
    assert len(calls) == 1

    # Once the window has passed, the next request tries again.
    view_source_kinds._failed_at -= 31
    _stub(monkeypatch, returns={"ds_v"})
    sets = await view_source_kinds.load_sets(db_session, required=False)
    assert sets is not None and sets.versioned_ds == {"ds_v"}
