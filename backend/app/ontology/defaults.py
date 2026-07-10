"""
System default ontology — thin JSON loader.

The authoritative data lives in system_ontology.json (next to this file).
Edit the JSON file to add/modify entity or relationship types.
Python code that previously imported SYSTEM_ENTITY_TYPES / SYSTEM_RELATIONSHIP_TYPES
directly continues to work via the module-level constants re-exported below.
"""
import json
import logging
from pathlib import Path
from typing import Any, Dict

logger = logging.getLogger(__name__)

_HERE = Path(__file__).parent
_ONTOLOGY_FILE = _HERE / "system_ontology.json"

_DATA: Dict[str, Any] = {}
try:
    _DATA = json.loads(_ONTOLOGY_FILE.read_text())
except FileNotFoundError:
    logger.warning(
        "system_ontology.json not found at %s — using empty defaults. "
        "Entity and relationship type definitions will be empty until an ontology is configured.",
        _ONTOLOGY_FILE,
    )
except (json.JSONDecodeError, OSError) as exc:
    logger.warning(
        "Failed to parse system_ontology.json at %s: %s — using empty defaults.",
        _ONTOLOGY_FILE, exc,
    )

SYSTEM_DEFAULT_ONTOLOGY_NAME: str = _DATA.get("name", "Synodic Default Ontology")
SYSTEM_DEFAULT_ONTOLOGY_VERSION: int = _DATA.get("version", 1)
SYSTEM_ENTITY_TYPES: Dict[str, Dict[str, Any]] = _DATA.get("entity_types", {})
SYSTEM_RELATIONSHIP_TYPES: Dict[str, Dict[str, Any]] = _DATA.get("relationship_types", {})

# ---------------------------------------------------------------------------
# System-internal (built-in) edge types
# ---------------------------------------------------------------------------
# Edge types the PLATFORM produces, not user data: the aggregation worker writes
# ``:AGGREGATED`` rollup edges into the graph. Every ontology implicitly includes these
# so (a) the resolution gate never blocks aggregation on an edge the platform itself
# emitted, and (b) the UI can always show them, marked built-in, without the user having
# to declare an implementation detail. Keyed UPPERCASE (the case-insensitive contract).
SYSTEM_INTERNAL_EDGE_TYPES: frozenset = frozenset({"AGGREGATED"})

# The full definitions for those types, sourced from the system ontology so there is one
# source of truth for their classification/visuals. Marked ``is_system`` for the UI.
SYSTEM_INTERNAL_RELATIONSHIP_TYPES: Dict[str, Dict[str, Any]] = {
    rid: {**rdef, "is_system": True}
    for rid, rdef in SYSTEM_RELATIONSHIP_TYPES.items()
    if rid.upper() in SYSTEM_INTERNAL_EDGE_TYPES
}


def is_system_edge_type(edge_type_id: str) -> bool:
    """True if ``edge_type_id`` is a platform-built-in edge (case-insensitive)."""
    return bool(edge_type_id) and str(edge_type_id).upper() in SYSTEM_INTERNAL_EDGE_TYPES


def with_system_edge_types(rel_defs_raw: Dict[str, Any]) -> Dict[str, Any]:
    """Return ``rel_defs_raw`` with the system-internal edge types merged in and always
    marked ``is_system``. Makes every ontology implicitly include the platform's built-in
    edges — for the resolution gate and for display. A user's own classification (if they
    happened to declare one) is preserved; only the built-in marker is forced on."""
    merged: Dict[str, Any] = {**(rel_defs_raw or {})}
    for rid, sdef in SYSTEM_INTERNAL_RELATIONSHIP_TYPES.items():
        existing = merged.get(rid)
        merged[rid] = {**existing, "is_system": True} if isinstance(existing, dict) else dict(sdef)
    return merged


def strip_system_edge_types(rel_defs: Dict[str, Any]) -> Dict[str, Any]:
    """Return ``rel_defs`` without the system-internal edge types — they are injected on
    read, never persisted, so a save round-trip can't store (or duplicate) them."""
    return {k: v for k, v in (rel_defs or {}).items() if not is_system_edge_type(k)}
