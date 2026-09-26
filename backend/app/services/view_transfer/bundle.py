"""Build and parse View Bundle files (``*.view.json``).

Parsing treats the file as untrusted input: size, nesting depth, view count and assignment
count are all capped (``limits``), the shape is validated by the models in
``backend.common.models.view_transfer``, and every view's integrity is checked by re-hashing its
definition. A file edited by hand after export still imports; it is flagged ``modified`` so the
person importing it knows the file is no longer exactly what was exported.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import ValidationError

from backend.app.services.view_transfer import limits
from backend.app.services.view_transfer.canonical import content_hash, portable_definition
from backend.app.services.view_transfer.references import reference_layout
from backend.common.models.view_transfer import (
    BUNDLE_FORMAT,
    BUNDLE_FORMAT_VERSION,
    ViewBundle,
)

INTEGRITY_VERIFIED = "verified"
INTEGRITY_MODIFIED = "modified"
INTEGRITY_UNVERIFIABLE = "unverifiable"


class BundleError(ValueError):
    """A file that cannot be imported, with a sentence a person can act on."""

    def __init__(self, message: str, *, code: str = "invalid_bundle"):
        super().__init__(message)
        self.code = code


@dataclass
class ParsedView:
    index: int
    source_key: str
    portable_id: str
    definition: dict              # canonical form of what the file holds
    claimed_hash: str
    actual_hash: str
    integrity: str
    raw: Dict[str, Any]           # the view entry as the file wrote it (validated)


@dataclass
class ParsedBundle:
    bundle: ViewBundle
    views: List[ParsedView] = field(default_factory=list)
    integrity: str = INTEGRITY_VERIFIED
    notices: List[Dict[str, str]] = field(default_factory=list)


def bundle_hash(views: List[Dict[str, Any]]) -> str:
    """The hash of the set: which views, in which order, holding which designs."""
    return content_hash([[v.get("portableId"), v.get("definitionHash")] for v in views])


def _max_depth(value: Any) -> int:
    """Nesting depth of a decoded JSON value, iteratively (no recursion to exhaust)."""
    deepest = 0
    stack = [(value, 1)]
    while stack:
        node, depth = stack.pop()
        if depth > deepest:
            deepest = depth
            if deepest > limits.MAX_JSON_DEPTH:
                return deepest
        if isinstance(node, dict):
            stack.extend((v, depth + 1) for v in node.values())
        elif isinstance(node, list):
            stack.extend((v, depth + 1) for v in node)
    return deepest


def check_depth(value: Any) -> None:
    """Refuse a decoded value nested deeper than any real view (e.g. a definition posted as
    JSON rather than uploaded as a file)."""
    if _max_depth(value) > limits.MAX_JSON_DEPTH:
        raise BundleError("This view is nested too deeply to be a real view.", code="too_deep")


def decode_json(raw: bytes) -> Any:
    """Decode a JSON file, refusing anything too big or too deep to be a real bundle."""
    if len(raw) > limits.MAX_BUNDLE_BYTES:
        raise BundleError(
            f"This file is {len(raw) // (1024 * 1024)} MB; the limit is "
            f"{limits.MAX_BUNDLE_BYTES // (1024 * 1024)} MB.", code="too_large")
    text = raw.decode("utf-8-sig", errors="strict") if isinstance(raw, (bytes, bytearray)) else raw
    try:
        value = json.loads(text)
    except RecursionError:
        raise BundleError("This file is nested too deeply to be a view file.", code="too_deep")
    except ValueError as exc:
        raise BundleError(f"This isn't valid JSON ({exc}).", code="not_json")
    if _max_depth(value) > limits.MAX_JSON_DEPTH:
        raise BundleError("This file is nested too deeply to be a view file.", code="too_deep")
    return value


def parse_bundle(raw: bytes) -> ParsedBundle:
    """Validate a bundle and verify each view's integrity. Raises :class:`BundleError`."""
    try:
        value = decode_json(raw)
    except UnicodeDecodeError:
        raise BundleError("This file isn't UTF-8 text, so it isn't a view file.", code="not_json")
    if not isinstance(value, dict) or value.get("format") != BUNDLE_FORMAT:
        raise BundleError(
            "This isn't a view file. Export one from a view's Export action and try again.",
            code="wrong_format")
    version = value.get("formatVersion")
    if not isinstance(version, int) or version < 1:
        raise BundleError("This view file has no valid format version.", code="wrong_format")
    if version > BUNDLE_FORMAT_VERSION:
        raise BundleError(
            f"This file was made by a newer version of the platform (format {version}; this one "
            f"reads up to {BUNDLE_FORMAT_VERSION}). Upgrade this environment, or export the view "
            "again from an environment that matches.", code="newer_format")
    views_raw = value.get("views")
    if not isinstance(views_raw, list) or not views_raw:
        raise BundleError("This view file contains no views.", code="empty")
    if len(views_raw) > limits.MAX_VIEWS_PER_BUNDLE:
        raise BundleError(
            f"This file holds {len(views_raw)} views; the limit is {limits.MAX_VIEWS_PER_BUNDLE}. "
            "Export them in smaller groups.", code="too_many_views")

    try:
        bundle = ViewBundle.model_validate(value)
    except ValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()))
        raise BundleError(f"This view file is damaged: {where} {first.get('msg', 'is invalid')}.",
                          code="invalid_bundle")

    parsed = ParsedBundle(bundle=bundle)
    total_assignments = 0
    all_verified = True
    for index, view in enumerate(bundle.views):
        if view.source not in bundle.sources:
            raise BundleError(
                f"View {index + 1} ({view.metadata.name!r}) names a source the file doesn't "
                "describe.", code="invalid_bundle")
        definition = portable_definition(view.definition, view.metadata.viewType)
        rl = reference_layout(definition) or {}
        assignments = rl.get("assignments")
        total_assignments += len(assignments) if isinstance(assignments, dict) else 0
        actual = content_hash(definition)
        integrity = INTEGRITY_VERIFIED if actual == view.definitionHash else INTEGRITY_MODIFIED
        all_verified = all_verified and integrity == INTEGRITY_VERIFIED
        parsed.views.append(ParsedView(
            index=index, source_key=view.source, portable_id=view.portableId,
            definition=definition, claimed_hash=view.definitionHash, actual_hash=actual,
            integrity=integrity, raw=view.model_dump(mode="json"),
        ))
        if integrity == INTEGRITY_MODIFIED:
            parsed.notices.append({
                "code": "modified",
                "view": view.metadata.name,
                "message": f"{view.metadata.name!r} was edited after it was exported. It will "
                           "import as it is now, not as it was exported.",
            })
    if total_assignments > limits.MAX_ASSIGNMENTS_PER_BUNDLE:
        raise BundleError(
            f"This file holds {total_assignments:,} assignments; the limit is "
            f"{limits.MAX_ASSIGNMENTS_PER_BUNDLE:,}.", code="too_many_assignments")

    if bundle.bundleHash is None:
        parsed.integrity = INTEGRITY_UNVERIFIABLE
    elif all_verified and bundle.bundleHash == bundle_hash([v.raw for v in parsed.views]):
        parsed.integrity = INTEGRITY_VERIFIED
    else:
        parsed.integrity = INTEGRITY_MODIFIED
        if all_verified:
            parsed.notices.append({
                "code": "set_changed",
                "message": "Views were added to or removed from this file after it was exported.",
            })
    return parsed


def assemble_bundle(
    *,
    views: List[Dict[str, Any]],
    sources: Dict[str, Dict[str, Any]],
    exported_by: Optional[str],
    product: Optional[str],
    environment: Optional[str],
) -> Dict[str, Any]:
    """The file an export writes. ``views`` are finished entries (see ``service.export``)."""
    return {
        "format": BUNDLE_FORMAT,
        "formatVersion": BUNDLE_FORMAT_VERSION,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "exportedBy": {"displayName": exported_by},
        "generator": {"product": product, "environment": environment or None},
        "sources": sources,
        "views": views,
        "bundleHash": bundle_hash(views),
    }
