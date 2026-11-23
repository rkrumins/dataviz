"""Who a question about a subject goes to.

**Who to ask** (:func:`who_to_ask`):

* the view's owners — its creator, then its editor grantees (a group's members, the
  first 50 of them);
* the data's owners — the source's named Owner and Stewards; when it names nobody,
  the people derived from it (who created it, and the people named on the data
  requests connected as it); a view's are its data source's;
* the fallback, when nobody above can open the subject or the source names and
  derives nobody: the workspace's admins, else the Org Admins.

**Routing a question** (:func:`route`): the parts the asker chose plus the people they
added, deduplicated, without the asker, and only people who can open the subject (the
rest come back as ``not_reached`` with why), at most 50 — the owners first.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import GroupORM
from backend.app.db.repositories import data_source_contact_repo
from backend.app.services.discussions import readers as rd
from backend.app.services.discussions.people import people_map
from backend.common.models.discussions import DataContactsPeople, PersonRole, WhoToAskResponse
from backend.common.service_accounts import is_service_account

#: Members of one group asked at once, at most; the rest are counted in ``truncated``.
GROUP_CUT = 50
#: People one question reaches, at most.
RECIPIENTS_MAX = 50


@dataclass
class Role:
    person_id: str
    via: str
    group_id: Optional[str] = None
    group_name: Optional[str] = None
    can_read: bool = False


@dataclass
class WhoToAsk:
    view_owners: list[Role] = field(default_factory=list)
    owner: Optional[Role] = None
    stewards: list[Role] = field(default_factory=list)
    provenance: str = "fallback"
    fallback: list[Role] = field(default_factory=list)
    truncated: int = 0
    #: Groups cut at :data:`GROUP_CUT`, by id.
    cut_groups: list[str] = field(default_factory=list)

    def everyone(self) -> list[Role]:
        return self.view_owners + ([self.owner] if self.owner else []) + self.stewards + self.fallback


async def group_names(session: AsyncSession, ids: Iterable[str]) -> dict[str, str]:
    wanted = sorted(set(ids))
    if not wanted:
        return {}
    return dict((await session.execute(select(GroupORM.id, GroupORM.name).where(GroupORM.id.in_(wanted)))).all())


class _Expander:
    """Turns ``(subject_type, subject_id)`` into people, each group cut at
    :data:`GROUP_CUT`, counting what was cut."""

    def __init__(self, members: dict[str, list[str]], names: dict[str, str]):
        self.members, self.names = members, names
        self.truncated, self.cut_groups = 0, []

    def roles(self, subjects: Iterable[tuple[str, str]], via: str) -> list[Role]:
        out: list[Role] = []
        for kind, sid in subjects:
            if kind == "user":
                out.append(Role(person_id=sid, via=via))
                continue
            members = self.members.get(sid, [])
            if len(members) > GROUP_CUT:
                self.truncated += len(members) - GROUP_CUT
                self.cut_groups.append(sid)
            out += [Role(person_id=u, via=via, group_id=sid, group_name=self.names.get(sid))
                    for u in members[:GROUP_CUT]]
        return out


async def who_to_ask(session: AsyncSession, subject: rd.Subject, readers: rd.Readers) -> WhoToAsk:
    """The people to ask about ``subject``, each marked with whether they can open it."""
    out = WhoToAsk()
    editors = await rd.grantees(session, subject.id, role="editor") if subject.type == "view" else []
    source = subject if subject.type == "data_source" else (
        await rd.load_subject(session, "data_source", subject.data_source_id) if subject.data_source_id else None
    )
    rows = await data_source_contact_repo.list_for_source(session, source.id) if source else []
    group_ids = [sid for kind, sid in editors if kind == "group"] + [r.subject_id for r in rows if r.subject_type == "group"]
    expander = _Expander(await rd.group_members(session, group_ids), await group_names(session, group_ids))

    if subject.type == "view":
        out.view_owners = ([Role(person_id=subject.created_by, via="creator")] if subject.created_by else []) \
            + expander.roles(editors, "editor_grant")
    if rows:
        out.provenance = "named"
        owners = expander.roles([(r.subject_type, r.subject_id) for r in rows if r.role == "owner"], "named_owner")
        out.owner = owners[0] if owners else None
        out.stewards = owners[1:] + expander.roles(
            [(r.subject_type, r.subject_id) for r in rows if r.role == "steward"], "named_steward")
    elif source is not None:
        creator, known = await rd.derived_contacts(session, source)
        out.owner = Role(person_id=creator, via="created_source") if creator else None
        out.stewards = [Role(person_id=u, via="data_request") for u in known]
        out.provenance = "derived" if (creator or known) else "fallback"
    out.truncated, out.cut_groups = expander.truncated, expander.cut_groups

    named = out.everyone()
    readable = await readers.among(session, [r.person_id for r in named])
    for r in named:
        r.can_read = r.person_id in readable
    if out.provenance == "fallback" or not readable:
        out.fallback = await fallback(session, subject.workspace_id, readers)
    return out


async def fallback(session: AsyncSession, workspace_id: str, readers: rd.Readers) -> list[Role]:
    """The workspace's admins, else the Org Admins."""
    admins, via = await rd.workspace_admins(session, workspace_id), "workspace_admin"
    if not admins:
        admins, via = await rd.org_admins(session), "org_admin"
    can = await readers.among(session, admins)
    return [Role(person_id=u, via=via, can_read=u in can) for u in sorted(admins)][:RECIPIENTS_MAX]


@dataclass
class Routed:
    reached: list[str]
    not_reached: list[tuple[str, str]]
    used_fallback: bool


async def route(
    session: AsyncSession, subject: rd.Subject, wta: WhoToAsk, *, view_owners: bool, data_contacts: bool,
    recipient_ids: list[str], asker_id: str, readers: rd.Readers,
) -> Routed:
    """Who a question reaches, and who it could not, with why."""
    data = data_contacts and wta.provenance != "fallback"
    first = ([wta.view_owners[0]] if view_owners and wta.view_owners else []) + \
            ([wta.owner] if data and wta.owner else [])
    rest = (wta.view_owners[1:] if view_owners else []) + (wta.stewards if data else [])
    ordered = [r.person_id for r in first] + list(recipient_ids) + [r.person_id for r in rest]
    candidates = [u for u in dict.fromkeys(ordered) if u and u != asker_id]

    can = await readers.among(session, candidates)
    active = await rd.active_people(session, candidates) if len(can) < len(candidates) else set(candidates)
    reached = [u for u in candidates if u in can][:RECIPIENTS_MAX]
    not_reached = [
        (u, "not_a_person" if is_service_account(u) else "inactive" if u not in active else "cannot_read")
        for u in candidates if u not in can
    ]
    if view_owners or data:
        not_reached += [(g, "group_too_large") for g in wta.cut_groups]

    used_fallback = False
    if (data_contacts and wta.provenance == "fallback") or ((view_owners or data_contacts) and not reached):
        spare = wta.fallback or await fallback(session, subject.workspace_id, readers)
        extra = [r.person_id for r in spare if r.can_read and r.person_id != asker_id
                 and r.person_id not in reached]
        if extra:
            used_fallback = True
            reached = (reached + extra)[:RECIPIENTS_MAX]
    return Routed(reached=reached, not_reached=not_reached, used_fallback=used_fallback)


def _role(r: Role) -> PersonRole:
    return PersonRole(person_id=r.person_id, via=r.via, group_id=r.group_id, group_name=r.group_name,
                      can_read=r.can_read)


async def present(session: AsyncSession, wta: WhoToAsk) -> WhoToAskResponse:
    """``GET /discussions/subjects/{type}/{id}/people``'s body."""
    return WhoToAskResponse(
        view_owners=[_role(r) for r in wta.view_owners],
        data_contacts=DataContactsPeople(owner=_role(wta.owner) if wta.owner else None,
                                         stewards=[_role(r) for r in wta.stewards], provenance=wta.provenance),
        fallback=[_role(r) for r in wta.fallback], truncated=wta.truncated,
        people=await people_map(session, [r.person_id for r in wta.everyone()]),
    )
