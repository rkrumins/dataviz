"""Each migration revision a database has met, with its parents, kept in the database itself.

``alembic_version`` says where a database stands, by revision id alone. A build that doesn't have
that revision — another branch's, a newer release's, one with a merge revision made by hand —
can't tell from the id what the database has run. So every build that migrates or stamps a
database (``alembic/env.py``) writes its whole chain here, and the upgrade Job walks a stamp it
doesn't know down this table to its own chain (``scripts/upgrade.py``), however the stamp came
about. A revision two builds gave different parents keeps both.
"""
from __future__ import annotations

from sqlalchemy import inspect, text

TABLE = "alembic_lineage"


def _parents(revision) -> list[str]:
    down = revision.down_revision
    return [] if down is None else [down] if isinstance(down, str) else sorted(down)


def record(connection, script) -> None:
    """Write every revision of ``script``'s chain, with its parents. Idempotent."""
    connection.execute(text(
        f"CREATE TABLE IF NOT EXISTS {TABLE} ("
        "revision VARCHAR(128) NOT NULL, parents TEXT NOT NULL, "
        "PRIMARY KEY (revision, parents))"))
    connection.execute(
        text(f"INSERT INTO {TABLE} (revision, parents) VALUES (:revision, :parents) "
             "ON CONFLICT DO NOTHING"),
        [{"revision": rev.revision, "parents": ",".join(_parents(rev))} for rev in script.walk_revisions()])


def read(connection) -> dict[str, list[list[str]]]:
    """Each revision recorded, with every set of parents it was given. Empty before any record."""
    if not inspect(connection).has_table(TABLE):
        return {}
    out: dict[str, list[list[str]]] = {}
    for revision, parents in connection.execute(
            text(f"SELECT revision, parents FROM {TABLE} ORDER BY revision, parents")):
        out.setdefault(revision, []).append(parents.split(",") if parents else [])
    return out
