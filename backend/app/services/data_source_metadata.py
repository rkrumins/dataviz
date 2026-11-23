"""A data source's details: what it is, where to read more, and whether to trust it.

* **Reading** them takes ``workspace:datasource:read``, with the switch on or off. Along
  with what was written comes the catalog item's description (shown when the source has
  none of its own), who set the current status, and how the source came to be — when,
  by whom, from what (:func:`onboarding_how`) and for which data request, when the reader
  can read that request's workspace.
* **The description, links and tags** are changed by whoever manages the source
  (``workspace:datasource:manage``); in the Playground, only by the person who made it.
* **The classification, status and note** are changed by the workspace's admins and the
  source's named Owner and Stewards — directly, or through a group they are in
  (403 ``not_steward``) — and never in the Playground (403 ``playground_no_trust``).
  Setting a different status records who set it and when; clearing it clears both.

Both saves send the ``updatedAt`` they read; a source changed since answers 409 ``stale``
with what it is now. A save that changes nothing records nothing. Each change writes
``workspace.data_source.metadata_changed`` (which fields, and the tags added and removed —
never the description's text) or ``workspace.data_source.trust_changed`` (from and to) to
the activity ledger. The switch (``dataSourceMetadataEnabled``) gates saving; reading never.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.common.activity_context import provenance_for
from backend.app.db.models import CatalogItemORM, WorkspaceDataSourceORM
from backend.app.db.repositories import data_request_repo, user_repo
from backend.app.db.repositories.data_source_repo import json_list
from backend.app.jobs import metrics
from backend.app.services import playground_policy
from backend.app.services.activity import recorder
from backend.app.services.data_source_contacts import is_named_contact, live_source
from backend.app.services.discussions.access import refuse, require_person
from backend.app.services.discussions.people import people_map
from backend.app.services.feature_flags import feature_flags
from backend.app.services.managed_sources import origin_of
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.auth_service.interface import User
from backend.common.models import data_source_metadata as m
from backend.common.service_accounts import is_service_account

FLAG = "dataSourceMetadataEnabled"
READ = "workspace:datasource:read"
MANAGE = "workspace:datasource:manage"
ADMIN = "workspace:admin"
_ORIGIN_HOW = {"viewPackage": "view_package", "fork": "fork"}


async def switch_on() -> bool:
    return await feature_flags.is_enabled_self_session(FLAG, default=False)


def onboarding_how(ds: WorkspaceDataSourceORM) -> str:
    """How the source came to be: what its ``extra_config`` says it was made from, else
    from the catalog, else built from blank (managed), else a provider's graph."""
    kind = (origin_of(ds.extra_config) or {}).get("kind")
    if kind in _ORIGIN_HOW:
        return _ORIGIN_HOW[kind]
    if ds.fork_of_data_source_id:
        return "fork"
    if ds.catalog_item_id:
        return "catalog"
    return "blank" if ds.source_mode == "managed" else "provider"


def _links(ds: WorkspaceDataSourceORM) -> list[m.DataSourceLink]:
    return [m.DataSourceLink(label=link["label"], url=link["url"]) for link in json_list(ds.links)
            if isinstance(link, dict) and isinstance(link.get("label"), str) and isinstance(link.get("url"), str)]


async def _from_request(session: AsyncSession, claims: PermissionClaims, ds_id: str) -> Optional[m.OnboardingRequest]:
    row = await data_request_repo.first_connected_as(session, ds_id)
    if row is None or not has_permission(claims, READ, workspace_id=row.workspace_id):
        return None
    ident = (await user_repo.get_identities_by_ids(session, [row.requested_by])).get(row.requested_by)
    return m.OnboardingRequest(
        id=row.id, title=row.title, requester_name=(ident["name"] or ident["email"]) if ident else None,
        requested_at=row.created_at, connected_at=row.resolved_at,
    )


async def _may_set_trust(session: AsyncSession, user: User, claims: PermissionClaims,
                         ds: WorkspaceDataSourceORM) -> bool:
    return has_permission(claims, ADMIN, workspace_id=ds.workspace_id) or await is_named_contact(session, user, ds.id)


async def read(session: AsyncSession, user: User, claims: PermissionClaims,
               ds: WorkspaceDataSourceORM) -> m.DataSourceMetadata:
    """The source's details as the caller sees them, with what they may change."""
    people = await people_map(session, [ds.trust_status_by, ds.metadata_updated_by, ds.created_by])
    catalog = await session.get(CatalogItemORM, ds.catalog_item_id) if ds.catalog_item_id else None
    playground = await playground_policy.playground_of(session, ds.workspace_id)
    person = await switch_on() and not is_service_account(user.id)
    can_edit = person and has_permission(claims, MANAGE, workspace_id=ds.workspace_id) and (
        playground is None or playground_policy.is_owner_or_admin(ds.workspace_id, ds.created_by, user.id, claims)
    )
    can_edit_trust = person and playground is None and await _may_set_trust(session, user, claims, ds)
    return m.DataSourceMetadata(
        data_source_id=ds.id, description=ds.description,
        catalog_description=catalog.description if catalog is not None else None,
        links=_links(ds), tags=json_list(ds.tags), classification=ds.classification,
        trust_status=ds.trust_status, trust_note=ds.trust_note,
        trust_status_by=people.get(ds.trust_status_by) if ds.trust_status_by else None,
        trust_status_at=ds.trust_status_at, updated_at=ds.metadata_updated_at,
        updated_by=people.get(ds.metadata_updated_by) if ds.metadata_updated_by else None,
        onboarding=m.Onboarding(
            at=ds.created_at, by=people.get(ds.created_by) if ds.created_by else None, how=onboarding_how(ds),
            from_request=await _from_request(session, claims, ds.id),
        ),
        can_edit=can_edit, can_edit_trust=can_edit_trust,
    )


# ── Checking what is saved ───────────────────────────────────────────


def _clean_text(raw: Optional[str], limit: int, what: str) -> Optional[str]:
    text = (raw or "").strip() or None
    if text is not None and len(text) > limit:
        raise refuse(422, "body_invalid", f"{what} is at most {limit:,} characters.")
    return text


def _web_address(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:          # e.g. an unclosed IPv6 bracket
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def _clean_links(links: list[m.DataSourceLink]) -> list[dict]:
    out: dict[str, dict] = {}
    for i, link in enumerate(links):
        label, url = link.label.strip(), link.url.strip()
        if not 1 <= len(label) <= m.LINK_LABEL_MAX:
            raise refuse(422, "invalid_links", f"A link's label is 1 to {m.LINK_LABEL_MAX} characters.", index=i)
        if len(url) > m.LINK_URL_MAX or not _web_address(url):
            raise refuse(422, "invalid_links", "A link is a web address starting http:// or https://.", index=i)
        out.setdefault(url, {"label": label, "url": url})
    if len(out) > m.LINKS_MAX:
        raise refuse(422, "invalid_links", f"A data source can have at most {m.LINKS_MAX} links.")
    return list(out.values())


def _clean_tags(tags: list[str]) -> list[str]:
    out: dict[str, str] = {}
    for raw in tags:
        tag = raw.strip()
        if not tag:
            continue
        if len(tag) > m.TAG_MAX:
            raise refuse(422, "body_invalid", f"A tag is at most {m.TAG_MAX} characters.")
        out.setdefault(tag.casefold(), tag)
    if len(out) > m.TAGS_MAX:
        raise refuse(422, "too_many_tags", f"A data source can have at most {m.TAGS_MAX} tags.")
    return list(out.values())


async def _check_fresh(session: AsyncSession, user: User, claims: PermissionClaims,
                       ds: WorkspaceDataSourceORM, expected_updated_at: Optional[str]) -> None:
    """409 when the source's details changed since the editor read them."""
    if expected_updated_at != ds.metadata_updated_at:
        metrics.increment("data_source_metadata_stale_total")
        raise refuse(409, "stale", "Someone changed this data source's details since you opened them.",
                     current=(await read(session, user, claims, ds)).model_dump(by_alias=True))


def _stamp(ds: WorkspaceDataSourceORM, user: User) -> str:
    now = datetime.now(timezone.utc).isoformat()
    ds.metadata_updated_by, ds.metadata_updated_at = user.id, now
    return now


# ── Saving ───────────────────────────────────────────────────────────


async def save_details(session: AsyncSession, user: User, claims: PermissionClaims, workspace_id: str,
                       data_source_id: str, body: m.DataSourceDetailsUpdate) -> m.DataSourceMetadata:
    """Replace the description, links and tags (the route checks the switch and ``…:manage``)."""
    require_person(user)
    # Locked, so two saves decide one after the other.
    ds = await live_source(session, workspace_id, data_source_id, for_update=True)
    await playground_policy.assert_owner(session, workspace_id, ds.created_by, user.id, claims)
    new = {
        "description": _clean_text(body.description, m.DESCRIPTION_MAX, "A description"),
        "links": _clean_links(body.links),
        "tags": _clean_tags(body.tags),
    }
    await _check_fresh(session, user, claims, ds, body.expected_updated_at)
    old = {"description": ds.description, "links": json_list(ds.links), "tags": json_list(ds.tags)}
    changed = sorted(k for k in new if new[k] != old[k])
    if not changed:
        return await read(session, user, claims, ds)

    ds.description = new["description"]
    ds.links = json.dumps(new["links"]) if new["links"] else None
    ds.tags = json.dumps(new["tags"]) if new["tags"] else None
    _stamp(ds, user)
    before = {t.casefold() for t in old["tags"]}
    after = {t.casefold() for t in new["tags"]}
    await recorder.record_activity(
        session, event_type="workspace.data_source.metadata_changed", provenance=provenance_for(user),
        **recorder.data_source_target(ds),
        details={"fields": changed, "tagsAdded": [t for t in new["tags"] if t.casefold() not in before],
                 "tagsRemoved": [t for t in old["tags"] if t.casefold() not in after]},
    )
    metrics.increment("data_source_metadata_saved_total", kind="details")
    return await read(session, user, claims, ds)


async def save_trust(session: AsyncSession, user: User, claims: PermissionClaims, workspace_id: str,
                     data_source_id: str, body: m.DataSourceTrustUpdate) -> m.DataSourceMetadata:
    """Replace the classification, status and note (the route checks the switch and
    ``…:read``; this, who may)."""
    require_person(user)
    ds = await live_source(session, workspace_id, data_source_id, for_update=True)
    if await playground_policy.playground_of(session, workspace_id):
        raise refuse(403, "playground_no_trust",
                     "Nothing in the Playground is certified or classified: it holds experiments, not data to rely on.")
    if not await _may_set_trust(session, user, claims, ds):
        raise refuse(403, "not_steward",
                     "Only the workspace's admins and this source's Owner and Stewards can set how far to trust it.")
    note = _clean_text(body.trust_note, m.NOTE_MAX, "A status note")
    await _check_fresh(session, user, claims, ds, body.expected_updated_at)
    before = {"classification": ds.classification, "trustStatus": ds.trust_status}
    after = {"classification": body.classification, "trustStatus": body.trust_status}
    note_changed = note != ds.trust_note
    if before == after and not note_changed:
        return await read(session, user, claims, ds)

    now = _stamp(ds, user)
    if body.trust_status != ds.trust_status:
        ds.trust_status_by, ds.trust_status_at = (user.id, now) if body.trust_status else (None, None)
    ds.classification, ds.trust_status, ds.trust_note = body.classification, body.trust_status, note
    details = {k: {"from": before[k], "to": after[k]} for k in after if before[k] != after[k]}
    await recorder.record_activity(
        session, event_type="workspace.data_source.trust_changed", provenance=provenance_for(user),
        **recorder.data_source_target(ds), details={**details, "noteChanged": note_changed},
    )
    metrics.increment("data_source_metadata_saved_total", kind="trust")
    return await read(session, user, claims, ds)
