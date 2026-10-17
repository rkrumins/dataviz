"""A view-scoped replace deletes only what the view holds, so it never runs without that scope.

``run_import`` asks the injected ``replace_scope_resolver`` for the view's scope on the import's
draft. A view that places nothing, a resolver that fails, or no resolver at all fails the job
before the worker starts: without a scope the replace would delete across the whole data source.
The job row is faked at its session boundary, as in test_import_view_assignments.py.
"""
from __future__ import annotations

import contextlib
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import versioning as versioning_ep
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export import service as service_mod
from backend.app.services.versioning.import_export.service import ImportExportService


@pytest.fixture
def job(monkeypatch):
    row = SimpleNamespace(workspace_id="ws", data_source_id="ds", scope_view_id="v1",
                          reconcile_mode="replace", branch_id="br_9")

    @contextlib.asynccontextmanager
    async def session():
        class _S:
            async def get(self, _orm, _key):
                return row
        yield _S()

    monkeypatch.setattr(ver_db, "graphver_session", session)
    workers = []

    class _Worker:
        def __init__(self, _svc, _store, scope=None, ontology=None, facts=True):
            self.scope = scope
            self.created_node_facts = []
            workers.append(self)

        async def run(self, _job_id):
            return {"deleted": 1}

    monkeypatch.setattr(service_mod, "ImportWorker", _Worker)
    return row, workers


def _service(resolver=None):
    return ImportExportService(versioning=object(), store=object(), replace_scope_resolver=resolver)


async def test_a_replace_deletes_within_the_views_scope_on_the_draft(job):
    _row, workers = job
    asked = []

    async def resolver(*args):
        asked.append(args)
        return {"assigned_urns": ["urn:A"]}

    assert await _service(resolver).run_import("vjob_1") == {"deleted": 1}
    assert asked == [("ws", "ds", "v1", "br_9")]
    assert workers[0].scope == {"assigned_urns": ["urn:A"]}


async def test_a_view_that_places_nothing_imports_nothing(job):
    _row, workers = job

    async def resolver(*_args):
        return None

    with pytest.raises(ValueError, match="nothing placed in it"):
        await _service(resolver).run_import("vjob_1")
    assert workers == []


async def test_a_scope_that_cannot_be_read_fails_the_import(job):
    _row, workers = job

    async def resolver(*_args):
        raise RuntimeError("management DB down")

    with pytest.raises(RuntimeError, match="management DB down"):
        await _service(resolver).run_import("vjob_1")
    assert workers == []


async def test_without_a_resolver_a_view_scoped_replace_is_refused(job):
    _row, workers = job
    with pytest.raises(ValueError, match="nothing placed in it"):
        await _service().run_import("vjob_1")
    assert workers == []


async def test_an_upsert_never_asks_for_the_scope(job):
    row, workers = job
    row.reconcile_mode = "upsert"

    async def resolver(*_args):
        raise AssertionError("an upsert deletes nothing, so it needs no scope")

    await _service(resolver).run_import("vjob_1")
    assert workers[0].scope is None


def test_the_api_service_resolves_the_scope_failing_closed():
    """The factory (the transfer lane builds through it too) injects the resolver that raises on
    failure, not the export's, which falls back to the whole data source."""
    svc = versioning_ep.get_import_export_service()
    assert svc._replace_scope_resolver is versioning_ep._view_export_scope
