"""What ContextEngine refuses before it reads a past revision — no database.

A revision is of a version-controlled data source's published graph: a fork's past (its own
revisions over its root's), a draft's and a data source without version control are refused
(``RevisionUnsupported``, 501), never read from the graph as it is now. Each refusal comes before
the engine reads the graph's projection or builds a reader.
"""
import asyncio
from types import SimpleNamespace

import pytest

from backend.app.services.context_engine import ContextEngine
from backend.app.services.versioning.errors import RevisionUnsupported
from backend.app.services.versioning.service import GraphVersioningService


class _Registry:
    async def get_provider_for_workspace(self, workspace_id, session, data_source_id):
        return SimpleNamespace(name="live")


class _Session:
    """The management session: a fork's data source row, when asked."""

    def __init__(self, row=None):
        self.row = row

    async def get(self, model, key):
        return self.row


def _refused(ds, *, session=None, branch_id=None):
    with pytest.raises(RevisionUnsupported) as exc:
        asyncio.run(ContextEngine.for_workspace(
            "ws1", _Registry(), session or _Session(), data_source_id=ds, branch_id=branch_id,
            as_of_seq=3))
    assert exc.value.status_code == 501 and exc.value.detail["type"] == "revision_unsupported"
    return exc.value.detail["reason"]


@pytest.fixture()
def never_reads_the_projection(monkeypatch):
    async def watermark(self, gid):
        raise AssertionError("a refused revision read the projection")
    monkeypatch.setattr(GraphVersioningService, "projection_watermark", watermark)


def test_a_forks_past_is_refused(never_reads_the_projection):
    fork = SimpleNamespace(deleted_at=None, fork_of_data_source_id="ds_root")
    assert _refused("dsfork_1", session=_Session(fork)) == "fork"


def test_a_data_source_without_version_control_has_no_past(monkeypatch, never_reads_the_projection):
    async def no_graph(self, ds):
        return None
    monkeypatch.setattr(GraphVersioningService, "get_graph_by_data_source", no_graph)
    assert _refused("ds_plain") == "unversioned"


def test_a_drafts_past_is_refused(monkeypatch, never_reads_the_projection):
    async def graph(self, ds):
        return {"graph_id": "g1"}

    async def main(self, gid):
        return "br_main"
    monkeypatch.setattr(GraphVersioningService, "get_graph_by_data_source", graph)
    monkeypatch.setattr(GraphVersioningService, "main_branch_id", main)
    assert _refused("ds_1", branch_id="br_draft") == "draft"
