"""Is the data behind a view versioned here, or mastered somewhere else?

The Explorer's Versioned / External filter, and the ``sourceKind`` every view
carries, need that answer per view — and it lives in two stores that
deliberately do not know about each other. Which data sources are versioned is
a fact of the ``graphver`` store (a live ``graphs`` row, read by
:mod:`versioned_sources`); which source a view reads is a fact of the management
DB, and for a view that stores no data source it is its workspace's default.
This module brings the two together in Python. The graphver store is never
joined into a management query.

``workspace_data_sources.source_mode`` cannot answer the question instead:
``'managed'`` is never written by the bootstrap path that versions an existing
source, so most versioned sources have it NULL (see ``versioned_sources.py``).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import FrozenSet, Iterable, Literal, Mapping, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import data_source_repo
from backend.app.services import versioned_sources

logger = logging.getLogger(__name__)

SourceKind = Literal["versioned", "external"]

# The lookup's own ten-minute default suits the reconcile sweep, which only has
# to find out eventually. Someone who has just versioned a source and filters
# the Explorer for versioned views should see it there within a minute.
_LOOKUP_TTL_SECS = 60

# The lookup only raises when it has nothing cached to fall back on, and every
# view list asks it. Without this window, while the store is down every list
# request would wait on yet another attempt to reach it.
_NEGATIVE_TTL_SECS = 30

_failed_at: Optional[float] = None


class SourceKindUnavailable(RuntimeError):
    """The versioned set could not be read and the caller cannot do without it."""


@dataclass(frozen=True)
class SourceKindSets:
    """Everything needed to classify a set of views, loaded once per request."""

    versioned_ds: FrozenSet[str]
    # workspace id → its default data source id; workspaces with none are absent.
    ws_default: Mapping[str, str]

    @property
    def versioned_ws(self) -> FrozenSet[str]:
        """Workspaces whose default data source is versioned."""
        return frozenset(ws for ws, ds in self.ws_default.items() if ds in self.versioned_ds)

    @property
    def external_ws(self) -> FrozenSet[str]:
        """Workspaces that have a default data source, and it is not versioned."""
        return frozenset(ws for ws, ds in self.ws_default.items() if ds not in self.versioned_ds)

    def kind_for(self, ds_id: Optional[str], ws_id: Optional[str]) -> Optional[SourceKind]:
        """By the view's own data source, else its workspace's default. None when it
        has neither — it reads no data, so it is neither kind."""
        ds = ds_id or self.ws_default.get(ws_id)
        if not ds:
            return None
        return "versioned" if ds in self.versioned_ds else "external"


async def load_sets(
    session: AsyncSession,
    *,
    required: bool,
    workspace_ids: Optional[Iterable[str]] = None,
) -> Optional[SourceKindSets]:
    """The classification, or None when the versioned set is unknown.

    ``required`` is for a caller that FILTERS by kind: it gets
    :class:`SourceKindUnavailable` instead of None, because a filter quietly not
    applied returns a wrong answer that looks right. Every other caller only
    annotates, and shows the kind as unknown.

    ``workspace_ids`` narrows which workspace defaults are loaded (see
    ``data_source_repo.default_data_source_ids``).
    """
    global _failed_at
    if _failed_at is not None and time.monotonic() - _failed_at < _NEGATIVE_TTL_SECS:
        if required:
            raise SourceKindUnavailable("the versioned data-source lookup failed moments ago")
        return None
    try:
        # Through the module attribute, so a test's stub is what answers.
        versioned = await versioned_sources.versioned_data_source_ids(
            ttl_secs=_LOOKUP_TTL_SECS,
        )
    except Exception as exc:
        # VersionedLookupUnavailable is the expected failure, but nothing that goes
        # wrong reading another store is a reason to fail a view read.
        _failed_at = time.monotonic()
        logger.warning("source kinds unknown, versioned data-source lookup failed: %s", exc)
        if required:
            raise SourceKindUnavailable(str(exc)) from exc
        return None
    ws_default = await data_source_repo.default_data_source_ids(session, workspace_ids)
    return SourceKindSets(versioned_ds=versioned, ws_default=ws_default)


def reset() -> None:
    """Forget a recent lookup failure — used by tests."""
    global _failed_at
    _failed_at = None
