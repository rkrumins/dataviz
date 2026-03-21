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
