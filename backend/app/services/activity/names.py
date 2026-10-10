"""Name the ids an activity page mentions, in a handful of batched lookups.

A ledger row is ids — who (``usr_…``), where (``ws_…``), to what (``grp_…``,
``ds_…``, ``view_…``). Each kind is named once per PAGE: collected,
deduplicated, then one indexed ``IN`` per kind, so naming fifty rows costs
what naming one does.

One contract throughout, first written for the audit lens: deleted things are
still named (the log is a record of what happened, and "what was that source
we removed" is a question it exists to answer); an id that resolves to nothing
stays ABSENT, so the caller keeps showing the raw id rather than a name the
database cannot vouch for; and a failed lookup costs the names, never the page.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    GroupORM,
    IdpProviderORM,
    ProviderORM,
    ViewORM,
    WorkspaceDataSourceORM,
)
from backend.app.db.repositories import user_repo

logger = logging.getLogger(__name__)

#: Internal identifiers as they appear inside payloads and summaries.
#: Every referenceable kind ships a distinct prefix, which is what makes
#: naming them a lexical pass rather than a schema walk — a payload key
#: we have never heard of still gets its group (or person) named.
#:
#: ``usr`` is here as well as in the dedicated actor/target resolution:
#: those two cover the person a row is BY and the person it is ABOUT, but a
#: payload routinely names a third — a ``granted_by``, an inviter, a member
#: added to a group, the subject of an SSO mapping — and without this that
#: id rendered raw while every other kind beside it was named.
REF_ID = re.compile(r"\b(?:grp|ws|idp|view|usr)_[A-Za-z0-9]+\b")


async def resolve_reference_names(
    session: AsyncSession, ids: set[str],
) -> dict[str, str]:
    """Display names for the reference kinds without a dedicated lookup.

    People (``usr``) and workspaces (``ws``) are resolved by the caller,
    which already queries them for the actor/target and the event's own
    workspace and folds the payload references into those same two
    queries. This covers the rest — internal groups, IdP connections,
    views.
    """
    out: dict[str, str] = {}
    if not ids:
        return out
    by_prefix: dict[str, list[str]] = {}
    for i in ids:
        by_prefix.setdefault(i.split("_", 1)[0], []).append(i)

    try:
        if by_prefix.get("grp"):
            rows = await session.execute(
                select(GroupORM.id, GroupORM.name)
                .where(GroupORM.id.in_(by_prefix["grp"]))
            )
            out.update({i: n for i, n in rows.all() if n})
        if by_prefix.get("idp"):
            rows = await session.execute(
                select(IdpProviderORM.id, IdpProviderORM.display_name,
                       IdpProviderORM.slug)
                .where(IdpProviderORM.id.in_(by_prefix["idp"]))
            )
            out.update({
                i: (dn or slug) for i, dn, slug in rows.all() if dn or slug
            })
        if by_prefix.get("view"):
            rows = await session.execute(
                select(ViewORM.id, ViewORM.name)
                .where(ViewORM.id.in_(by_prefix["view"]))
            )
            out.update({i: n for i, n in rows.all() if n})
    except Exception:  # noqa: BLE001 — names are enrichment, ids are the record
        logger.warning(
            "audit: could not resolve reference names for this page",
            exc_info=True,
        )
    return out


async def _data_source_names(session: AsyncSession, ids: set[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = await session.execute(
        select(
            WorkspaceDataSourceORM.id,
            WorkspaceDataSourceORM.label,
            WorkspaceDataSourceORM.graph_name,
        ).where(WorkspaceDataSourceORM.id.in_(ids))
    )
    return {i: label or graph for i, label, graph in rows.all() if label or graph}


async def _provider_names(session: AsyncSession, ids: set[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = await session.execute(
        select(ProviderORM.id, ProviderORM.name).where(ProviderORM.id.in_(ids))
    )
    return {i: n for i, n in rows.all() if n}


@dataclass
class PageNames:
    """Everything one page's ids resolved to. Absent means unresolved."""

    people: dict[str, dict] = field(default_factory=dict)
    workspaces: dict[str, str] = field(default_factory=dict)
    #: Every other id — data sources, providers, groups, IdPs, views, and
    #: people and workspaces too — to the one name a sentence shows for it.
    names: dict[str, str] = field(default_factory=dict)

    def name_of(self, ref: str | None) -> str | None:
        return self.names.get(ref) if ref else None


async def name_page(
    session: AsyncSession,
    *,
    people: set[str],
    workspaces: set[str],
    references: set[str],
) -> PageNames:
    """Resolve one page's ids: a query per kind, each failure isolated.

    ``references`` may hold ids of any kind; ``usr_`` and ``ws_`` among them
    are folded into the people and workspace lookups, so a page never asks
    for either twice.
    """
    page = PageNames()
    people = {p for p in people | {r for r in references if r.startswith("usr_")} if p}
    workspaces = {w for w in workspaces | {r for r in references if r.startswith("ws_")} if w}

    try:
        page.people = await user_repo.get_identities_by_ids(session, sorted(people))
    except Exception:  # noqa: BLE001
        logger.warning("activity: could not name the people on this page", exc_info=True)
    try:
        page.workspaces = await user_repo.get_workspace_names_by_ids(session, sorted(workspaces))
    except Exception:  # noqa: BLE001
        logger.warning("activity: could not name the workspaces on this page", exc_info=True)

    others = {r for r in references if not r.startswith(("usr_", "ws_"))}
    names: dict[str, str] = {}
    try:
        names.update(await _data_source_names(session, {r for r in others if r.startswith("ds_")}))
        names.update(await _provider_names(session, {r for r in others if r.startswith("prov_")}))
    except Exception:  # noqa: BLE001
        logger.warning("activity: could not name the sources on this page", exc_info=True)
    names.update(await resolve_reference_names(
        session, {r for r in others if not r.startswith(("ds_", "prov_"))},
    ))
    for pid, person in page.people.items():
        if person.get("name") or person.get("email"):
            names[pid] = person.get("name") or person.get("email")
    names.update(page.workspaces)
    page.names = names
    return page
