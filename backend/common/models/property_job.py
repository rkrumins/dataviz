"""One bulk property operation — what a property job does to each entity it reaches — as the API
takes it. The jobs route (``api/v1/endpoints/versioning.py``) takes a job's in it, and a view's
library keeps one in each saved bulk recipe (``models/view_library.py``), so a recipe only ever
holds an operation a job would take.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


_PROPERTY_VALUE_MAX_BYTES = 64 * 1024


_ValueKind = Literal["Integer", "Float", "String", "Boolean"]


class PropertyValueMapping(_ApiModel):
    """One value a ``mapValues`` merges into another: ``from`` as it is stored — of ``fromKind``,
    else of the kind it is (a whole decimal needs it: JSON writes 1.0 as 1) — and what it becomes,
    ``to`` (of ``toKind``, else the kind it is). Text, a number or true/false, each."""
    from_: Any = Field(alias="from")
    from_kind: Optional[_ValueKind] = Field(default=None, alias="fromKind")
    to: Any
    to_kind: Optional[_ValueKind] = Field(default=None, alias="toKind")

    @model_validator(mode="after")
    def _scalars(self):
        from backend.app.services.versioning.import_export.property_job import as_kind, kind_of
        for side, value, kind in (("from", self.from_, self.from_kind), ("to", self.to, self.to_kind)):
            if (kind or kind_of(value)) not in ("Integer", "Float", "String", "Boolean"):
                raise ValueError(f"`{side}` is a text, a number or true/false")
            if isinstance(value, str) and len(value) > 4096:
                raise ValueError(f"`{side}` is longer than 4,096 characters")
            try:
                as_kind(kind or kind_of(value), value)
            except ValueError as exc:
                raise ValueError(f"`{side}`: {exc}") from None
        return self

    def wire(self) -> Dict[str, Any]:
        from backend.app.services.versioning.import_export.property_job import as_kind, kind_of
        fk, tk = self.from_kind or kind_of(self.from_), self.to_kind or kind_of(self.to)
        return {"from": as_kind(fk, self.from_), "fromKind": fk, "to": as_kind(tk, self.to), "toKind": tk}


class PropertyJobOp(_ApiModel):
    kind: Literal["set", "fillEmpty", "remove", "rename", "copy",
                  "replace", "normalize", "mapValues", "convert"]
    key: str = Field(min_length=1, max_length=128)
    to: Optional[str] = Field(default=None, min_length=1, max_length=128)
    value: Any = None
    on_conflict: Literal["skip", "overwrite"] = Field(default="skip", alias="onConflict")
    # The clean-ups (property_job.CLEANUPS): each rewrites the values ``key`` holds, where it is held
    # — a text or a list's text elements (a convert: any value).
    find: Optional[str] = Field(default=None, min_length=1, max_length=256)
    replace_with: Optional[str] = Field(default=None, alias="replaceWith", max_length=256)
    match_case: bool = Field(default=False, alias="matchCase")
    whole_value: bool = Field(default=False, alias="wholeValue")
    trim: bool = True
    collapse_spaces: bool = Field(default=False, alias="collapseSpaces")
    case: Optional[Literal["lower", "upper", "title"]] = None
    dedupe_list: Optional[bool] = Field(default=None, alias="dedupeList")
    map: Optional[List[PropertyValueMapping]] = Field(default=None, min_length=1, max_length=1000)
    to_kind: Optional[_ValueKind] = Field(default=None, alias="toKind")
    on_fail: Literal["skip", "remove"] = Field(default="skip", alias="onFail")

    @model_validator(mode="after")
    def _complete(self):
        if self.kind in ("rename", "copy") and self.to is None:
            raise ValueError(f"{self.kind} needs `to`, the key to write")
        if self.kind in ("set", "fillEmpty") and "value" not in self.model_fields_set:
            raise ValueError(f"{self.kind} needs `value`")
        if self.kind == "fillEmpty" and self.value in (None, ""):
            raise ValueError("fillEmpty fills with a value that isn't empty")
        if len(json.dumps(self.value, ensure_ascii=False).encode("utf-8")) > _PROPERTY_VALUE_MAX_BYTES:
            raise ValueError("value is larger than 64 KiB")
        if self.kind == "replace" and (self.find is None or self.replace_with is None):
            raise ValueError("replace needs `find`, and `replaceWith` (which may be empty)")
        if self.kind == "normalize" and not (self.trim or self.collapse_spaces or self.case or self.dedupe_list):
            raise ValueError("normalize needs something to do: trim, collapseSpaces, case or dedupeList")
        if self.kind == "mapValues":
            if not self.map:
                raise ValueError("mapValues needs `map`, the values to merge")
            wired = [e.wire() for e in self.map]
            froms = [json.dumps([m["fromKind"], m["from"]]) for m in wired]
            if len(set(froms)) < len(froms):
                raise ValueError("mapValues names a value in `from` more than once")
            if len(json.dumps(wired, ensure_ascii=False).encode("utf-8")) > 4 * _PROPERTY_VALUE_MAX_BYTES:
                raise ValueError("map is larger than 256 KiB")
        if self.kind == "convert" and self.to_kind is None:
            raise ValueError("convert needs `toKind`, the kind to store each value as")
        return self

    def wire(self) -> Dict[str, Any]:
        """As the job keeps it (``property_job.plan_patch``'s op)."""
        out: Dict[str, Any] = {"kind": self.kind, "key": self.key, "onConflict": self.on_conflict}
        if self.kind in ("rename", "copy"):
            out["to"] = self.to
        if self.kind in ("set", "fillEmpty"):
            out["value"] = self.value
        if self.kind == "replace":
            out.update(find=self.find, replaceWith=self.replace_with, matchCase=self.match_case,
                       wholeValue=self.whole_value)
        if self.kind == "normalize":
            out.update(trim=self.trim, collapseSpaces=self.collapse_spaces, case=self.case,
                       dedupeList=bool(self.dedupe_list))
        if self.kind == "mapValues":
            out.update(map=[m.wire() for m in self.map], dedupeList=self.dedupe_list is not False)
        if self.kind == "convert":
            out.update(toKind=self.to_kind, onFail=self.on_fail)
        return out
