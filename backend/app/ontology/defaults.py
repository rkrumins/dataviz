"""
System default ontology — thin JSON loader.

The authoritative data lives in system_ontology.json (next to this file).
Edit the JSON file to add/modify entity or relationship types.
Python code that previously imported SYSTEM_ENTITY_TYPES / SYSTEM_RELATIONSHIP_TYPES
directly continues to work via the module-level constants re-exported below.
"""
import json
from pathlib import Path
from typing import Any, Dict

_HERE = Path(__file__).parent
_DATA: Dict[str, Any] = json.loads((_HERE / "system_ontology.json").read_text())

SYSTEM_DEFAULT_ONTOLOGY_NAME: str = _DATA["name"]
SYSTEM_DEFAULT_ONTOLOGY_VERSION: int = _DATA["version"]
SYSTEM_ENTITY_TYPES: Dict[str, Dict[str, Any]] = _DATA["entity_types"]
SYSTEM_RELATIONSHIP_TYPES: Dict[str, Dict[str, Any]] = _DATA["relationship_types"]
