"""Layout templates: reusable Context View layer arrangements.

A template is the STRUCTURE of a Context View's layers — names, colours, icons,
descriptions, entity-type rules, logical nodes — never the entities one view
happened to place. Stored as ``context_models`` rows with ``is_template``; who
may use and change one is ``services/template_access.py``.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

TemplateVisibility = Literal["private", "workspace", "enterprise"]

#: A Context View column set that fits on a screen, with room to spare.
MAX_LAYERS = 30
#: Generous for 30 layers of rules and logical nodes; refuses a pasted graph.
MAX_LAYERS_BYTES = 256 * 1024


def _check_layers(layers: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    ids = set()
    for layer in layers:
        layer_id, name = layer.get("id"), layer.get("name")
        if not isinstance(layer_id, str) or not layer_id:
            raise ValueError("Every layer needs an id.")
        if layer_id in ids:
            raise ValueError(f"Two layers share the id '{layer_id}'.")
        ids.add(layer_id)
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ValueError("Every layer needs a name of 1 to 80 characters.")
    if len(json.dumps(layers)) > MAX_LAYERS_BYTES:
        raise ValueError("These layers are too large to keep as a template.")
    return layers


class LayoutTemplateAccess(BaseModel):
    """What the caller may do with one template — the UI shows only these."""
    model_config = ConfigDict(populate_by_name=True)
    #: How the caller reaches it: their own, a share, their workspace, the
    #: organization's, or a built-in.
    via: Literal["owner", "grant", "workspace", "organization", "builtin"]
    can_edit: bool = Field(alias="canEdit")
    can_delete: bool = Field(alias="canDelete")
    can_share: bool = Field(alias="canShare")
    can_hide: bool = Field(alias="canHide")


class LayoutTemplateResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    name: str
    description: Optional[str] = None
    category: Optional[str] = None
    visibility: TemplateVisibility
    built_in: bool = Field(alias="builtIn")
    #: A built-in hidden from everyone but template managers.
    hidden: bool = False
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    workspace_name: Optional[str] = Field(None, alias="workspaceName")
    layers: List[Dict[str, Any]] = Field(default_factory=list)
    created_by: Optional[str] = Field(None, alias="createdBy")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    #: Live views built from it that the caller can open.
    usage_count: int = Field(0, alias="usageCount")
    #: People and groups it is shared with; only for those who may share it.
    grant_count: Optional[int] = Field(None, alias="grantCount")
    access: LayoutTemplateAccess


class LayoutTemplateListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    items: List[LayoutTemplateResponse] = Field(default_factory=list)
    total: int = 0


class LayoutTemplateCreateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str = Field(min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=500)
    category: Optional[str] = Field(None, max_length=40)
    visibility: TemplateVisibility = "private"
    #: Required for the workspace tier, refused for the others.
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    layers: List[Dict[str, Any]] = Field(min_length=1, max_length=MAX_LAYERS)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("A template needs a name.")
        return v.strip()

    @field_validator("layers")
    @classmethod
    def _layers(cls, v: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return _check_layers(v)


class LayoutTemplateUpdateRequest(BaseModel):
    """Every field optional; an absent field is left as it is."""
    model_config = ConfigDict(populate_by_name=True)
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=500)
    category: Optional[str] = Field(None, max_length=40)
    visibility: Optional[TemplateVisibility] = None
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    layers: Optional[List[Dict[str, Any]]] = Field(None, min_length=1, max_length=MAX_LAYERS)

    @field_validator("name")
    @classmethod
    def _name(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not v.strip():
            raise ValueError("A template needs a name.")
        return v.strip() if v is not None else v

    @field_validator("layers")
    @classmethod
    def _layers(cls, v: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, Any]]]:
        return _check_layers(v) if v is not None else v


class LayoutTemplateHiddenRequest(BaseModel):
    hidden: bool
