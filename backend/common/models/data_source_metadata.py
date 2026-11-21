"""Wire shapes for a data source's details: what it is, where to read more, and whether
to trust it. camelCase on the wire (``response_model_by_alias``).

What the routes do: ``backend.app.api.v1.endpoints.data_source_metadata``; the rules:
``backend.app.services.data_source_metadata``.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from backend.common.models.discussions import Person


class _Wire(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


Classification = Literal["public", "internal", "confidential", "restricted"]
TrustStatus = Literal["certified", "in_review", "deprecated"]
#: How a source came to be: from the catalog, built from blank, from a view package, as a
#: fork, or straight from a provider's graph.
OnboardingHow = Literal["catalog", "blank", "view_package", "fork", "provider"]

DESCRIPTION_MAX = 4000
NOTE_MAX = 500
LINKS_MAX = 10
LINK_LABEL_MAX = 80
LINK_URL_MAX = 2048
TAGS_MAX = 20
TAG_MAX = 40


class DataSourceLink(_Wire):
    """Where to read more. Checked by the service (``invalid_links``); these bounds only
    keep an absurd payload from being parsed."""
    label: str = Field(max_length=LINK_LABEL_MAX * 2)
    url: str = Field(max_length=LINK_URL_MAX * 2)


class OnboardingRequest(_Wire):
    """The data request a source was connected for."""
    id: str
    title: str
    requester_name: Optional[str] = None
    requested_at: str
    connected_at: Optional[str] = None


class Onboarding(_Wire):
    """When, by whom and how the source was connected — worked out, never stored."""
    at: Optional[str] = None
    by: Optional[Person] = None
    how: Optional[OnboardingHow] = None
    from_request: Optional[OnboardingRequest] = None


class DataSourceMetadata(_Wire):
    """``GET``/``PUT /admin/workspaces/{ws}/data-sources/{ds}/metadata`` (and ``…/trust``).
    ``updatedAt`` is the last change to any detail, and the token a save sends back as
    ``expectedUpdatedAt``."""
    data_source_id: str
    description: Optional[str] = None
    catalog_description: Optional[str] = None
    links: list[DataSourceLink] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    classification: Optional[Classification] = None
    trust_status: Optional[TrustStatus] = None
    trust_note: Optional[str] = None
    trust_status_by: Optional[Person] = None
    trust_status_at: Optional[str] = None
    updated_at: Optional[str] = None
    updated_by: Optional[Person] = None
    onboarding: Onboarding = Field(default_factory=Onboarding)
    can_edit: bool = False
    can_edit_trust: bool = False


class DataSourceDetailsUpdate(_Wire):
    """The description, links and tags, replaced together."""
    description: Optional[str] = Field(default=None, max_length=DESCRIPTION_MAX * 2)
    links: list[DataSourceLink] = Field(default_factory=list, max_length=LINKS_MAX * 5)
    tags: list[Annotated[str, Field(max_length=TAG_MAX * 5)]] = Field(default_factory=list, max_length=TAGS_MAX * 5)
    expected_updated_at: Optional[str] = None


class DataSourceTrustUpdate(_Wire):
    """The classification, the status and its note, replaced together."""
    classification: Optional[Classification] = None
    trust_status: Optional[TrustStatus] = None
    trust_note: Optional[str] = Field(default=None, max_length=NOTE_MAX * 2)
    expected_updated_at: Optional[str] = None
