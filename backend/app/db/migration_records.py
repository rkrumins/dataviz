"""What a database has met and run, kept in the database itself.

Two tables, written by ``alembic/env.py`` whenever a command migrates or stamps:

* ``alembic_lineage``: every revision of each build's chain that touched the database, with its
  parents. ``alembic_version`` says where a database stands by revision id alone, so a build
  without that revision walks this table down to its own chain to tell what the database ran
  (``scripts/upgrade.py``). A revision two builds gave different parents keeps both.
* ``alembic_history``: each migration step as it happened — the revision, whether it ``ran``, was
  ``stamped`` or ``downgraded``, a SHA-256 of its file, when, and the build that did it. The upgrade
  Job warns when a migration's file has changed since it ran here, since the change never reaches
  this database (and records the warning, as ``changed``, so it is given once). It also records
  each time it ``placed`` a database another build stamped, and whether the schema then bore the
  place out (``verified``) or the stamps went back (``restored``): a Job stopped in between leaves
  the placement open, and the next one checks it.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from sqlalchemy import inspect, text

LINEAGE = "alembic_lineage"
HISTORY = "alembic_history"


def checksum(path: str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build() -> str | None:
    """The build doing it, as ``deploy/build-images.sh`` recorded it in the upgrade image."""
    sha = os.getenv("SYNODIC_BUILD_SHA")
    return f"{os.getenv('SYNODIC_BUILD_REF', '?')}@{sha}" if sha else None


def ensure(connection) -> None:
    connection.execute(text(
        f"CREATE TABLE IF NOT EXISTS {LINEAGE} ("
        "revision VARCHAR(128) NOT NULL, parents TEXT NOT NULL, PRIMARY KEY (revision, parents))"))
    connection.execute(text(
        f"CREATE TABLE IF NOT EXISTS {HISTORY} ("
        "id BIGSERIAL PRIMARY KEY, revision VARCHAR(128) NOT NULL, kind VARCHAR(16) NOT NULL, "
        "checksum CHAR(64), at TIMESTAMPTZ NOT NULL DEFAULT now(), build TEXT, detail TEXT)"))


def _parents(revision) -> list[str]:
    down = revision.down_revision
    return [] if down is None else [down] if isinstance(down, str) else sorted(down)


def record_chain(connection, script) -> None:
    """Every revision of ``script``'s chain, with its parents. Idempotent."""
    ensure(connection)
    connection.execute(
        text(f"INSERT INTO {LINEAGE} (revision, parents) VALUES (:revision, :parents) "
             "ON CONFLICT DO NOTHING"),
        [{"revision": rev.revision, "parents": ",".join(_parents(rev))} for rev in script.walk_revisions()])


def record_step(connection, revision: str, kind: str, path: str | None, detail: dict | None = None) -> None:
    connection.execute(
        text(f"INSERT INTO {HISTORY} (revision, kind, checksum, build, detail) VALUES (:r, :k, :c, :b, :d)"),
        {"r": revision[:128], "k": kind, "c": checksum(path) if path else None, "b": build(),
         "d": json.dumps(detail) if detail is not None else None})


def open_placement(connection) -> dict | None:
    """The last placement's detail, when no check of the schema has closed it since."""
    if not inspect(connection).has_table(HISTORY):
        return None
    last = connection.execute(text(
        f"SELECT kind, detail FROM {HISTORY} WHERE kind IN ('placed', 'verified', 'restored') "
        "ORDER BY id DESC LIMIT 1")).first()
    return json.loads(last.detail) if last is not None and last.kind == "placed" else None


def read_chain(connection) -> dict[str, list[list[str]]]:
    """Each revision recorded, with every set of parents it was given. Empty before any record."""
    if not inspect(connection).has_table(LINEAGE):
        return {}
    out: dict[str, list[list[str]]] = {}
    for revision, parents in connection.execute(
            text(f"SELECT revision, parents FROM {LINEAGE} ORDER BY revision, parents")):
        out.setdefault(revision, []).append(parents.split(",") if parents else [])
    return out


def changed(connection, script) -> list[tuple[str, str]]:
    """``(revision, path)`` for each of ``script``'s migrations whose file is not what ran here, as
    the last checksum recorded for it says. Empty before any history."""
    if not inspect(connection).has_table(HISTORY):
        return []
    last = connection.execute(text(
        f"SELECT DISTINCT ON (revision) revision, checksum FROM {HISTORY} "
        "WHERE kind IN ('ran', 'changed') AND checksum IS NOT NULL ORDER BY revision, id DESC"))
    ours = {rev.revision: rev.path for rev in script.walk_revisions()}
    return [(revision, ours[revision]) for revision, recorded in last
            if revision in ours and checksum(ours[revision]) != recorded]
