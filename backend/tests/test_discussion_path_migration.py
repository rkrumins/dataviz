"""``20261204_1000_discussion_path``, without a database server: the revision follows
``20261203_1100_watch_edges`` and fits ``alembic_version``; it gives ``discussions`` the ORM's
``entity_path`` and ``entity_type``, a question asked before them keeping neither; its DDL is guarded,
so it runs on a database ``create_all`` already built and runs again; the downgrade drops them.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from backend.app.db.models import DiscussionORM

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
_REVISION = _VERSIONS / "20261204_1000_discussion_path.py"
_CONVERSATIONS = _VERSIONS / "20261123_1000_conversations.py"


def _module(path: Path = _REVISION):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(conn, step: str, path: Path = _REVISION) -> None:
    """Run a revision's ``upgrade`` or ``downgrade`` on ``conn``, as alembic would."""
    module = _module(path)
    with Operations.context(MigrationContext.configure(conn)):
        getattr(module, step)()


@pytest.fixture
def conn():
    """A database before it: ``discussions`` as ``20261123_1000_conversations`` makes it."""
    engine = sa.create_engine("sqlite://")
    with engine.connect() as c:
        _run(c, "upgrade", _CONVERSATIONS)
        yield c
    engine.dispose()


def _columns(conn) -> dict:
    return {c["name"]: (str(c["type"]), c["nullable"])
            for c in sa.inspect(conn).get_columns("discussions")}


def _insert(conn, i: int) -> None:
    """A question about an entity, as a writer from before the columns asks it."""
    conn.execute(sa.text(
        "INSERT INTO discussions (id, subject_type, subject_id, entity_id, entity_label, visibility, status,"
        " asked_by, excerpt, message_count, participant_count, last_activity_at, last_message_by, version,"
        " created_at, updated_at) VALUES (:id, 'view', 'v1', 'urn:t:gl', 'gl', 'open', 'open', 'usr_a', 'Why?',"
        " 1, 1, '2026-11-26', 'usr_a', 1, '2026-11-26', '2026-11-26')"), {"id": f"dis_{i}"})


def test_the_revision_follows_the_watch_edges_one_and_fits_alembic_version():
    module = _module()
    assert module.revision == _REVISION.stem and len(module.revision) <= 32
    assert module.down_revision == "20261203_1100_watch_edges"


def test_a_question_from_before_keeps_neither_and_it_runs_again(conn):
    _insert(conn, 1)
    _run(conn, "upgrade")
    columns = _columns(conn)
    assert columns["entity_path"] == ("TEXT", True) and columns["entity_type"] == ("TEXT", True)
    assert list(conn.execute(sa.text("SELECT entity_label, entity_path, entity_type FROM discussions"))) == [
        ("gl", None, None)]
    _run(conn, "upgrade")                                     # guarded: a second run changes nothing
    assert _columns(conn) == columns


def test_its_columns_are_the_orms_and_it_runs_on_what_create_all_built(conn):
    _run(conn, "upgrade")
    baseline = sa.create_engine("sqlite://")
    with baseline.connect() as built:
        DiscussionORM.__table__.create(built)
        orm = _columns(built)
        _run(built, "upgrade")                                # the baseline already holds them
        assert _columns(built) == orm
    baseline.dispose()
    for name in ("entity_path", "entity_type"):
        assert orm[name] == _columns(conn)[name]


def test_the_downgrade_drops_them_and_runs_again(conn):
    _run(conn, "upgrade")
    _insert(conn, 1)
    _run(conn, "downgrade")
    assert not {"entity_path", "entity_type"} & set(_columns(conn))
    assert [r[0] for r in conn.execute(sa.text("SELECT id FROM discussions"))] == ["dis_1"]
    _run(conn, "downgrade")                                   # and again: nothing left to drop
