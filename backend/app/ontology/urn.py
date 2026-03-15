"""
Canonical URN utilities for Synodic.

URN format:  urn:synodic:<source_system>:<entity_type>:<slug>

Examples
--------
  urn:synodic:manual:domain:a1b2c3d4
  urn:synodic:falkordb:dataset:orders_table
  urn:synodic:datahub:schemafield:urn:li:schemaField:(urn:li:dataset:…,id)

Rules
-----
- All components are lowercase-normalised.
- The <slug> may include URL-safe characters plus colons for external IDs that
  themselves contain colons (e.g. DataHub URNs nested inside a Synodic URN).
- Parsing is lenient: any string that starts with "urn:" is considered valid.

Design note
-----------
External provider IDs (DataHub, OpenMetadata) are kept verbatim inside <slug>
so round-trip identity is preserved. We never mangle provider-native URNs; we
only prefix them with our namespace when they don't already have one.
"""
import re
import uuid
from typing import Optional

# ─── Constants ────────────────────────────────────────────────────────────────

SYNODIC_PREFIX = "urn:synodic"
LEGACY_PREFIX = "urn:nexus"        # Produced by earlier code; treated as equivalent
_URN_RE = re.compile(r"^urn:[a-z][a-z0-9+\-.]*:", re.IGNORECASE)


# ─── Generation ───────────────────────────────────────────────────────────────

def make_urn(
    entity_type: str,
    slug: Optional[str] = None,
    source_system: str = "manual",
) -> str:
    """
    Generate a canonical Synodic URN.

    Parameters
    ----------
    entity_type:   Ontology entity type id (e.g. "domain", "dataset").
    slug:          Optional stable identifier.  Defaults to a random hex UUID.
    source_system: Origin system ("manual", "falkordb", "datahub", …).

    Returns
    -------
    A string like ``urn:synodic:manual:dataset:a1b2c3d4efgh``.
    """
    s = (slug or uuid.uuid4().hex[:12]).strip()
    return f"{SYNODIC_PREFIX}:{_safe(source_system)}:{_safe(entity_type)}:{s}"


def _safe(part: str) -> str:
    """Lowercase and strip leading/trailing whitespace from a URN component."""
    return part.lower().strip()


# ─── Normalisation ────────────────────────────────────────────────────────────

def normalize_urn(raw: str) -> str:
    """
    Normalise an inbound URN string.

    - Trims whitespace.
    - Converts legacy ``urn:nexus:`` prefix to ``urn:synodic:``.
    - Preserves all other URN formats verbatim (DataHub, OpenMetadata, custom).

    Parameters
    ----------
    raw: The raw URN string from a provider or user input.

    Returns
    -------
    A normalised URN string.  Never raises — returns the trimmed input if it
    cannot be understood.
    """
    raw = raw.strip()
    if raw.startswith(LEGACY_PREFIX + ":"):
        raw = SYNODIC_PREFIX + raw[len(LEGACY_PREFIX):]
    return raw


# ─── Validation ───────────────────────────────────────────────────────────────

def is_valid_urn(value: str) -> bool:
    """Return True if *value* looks like a syntactically valid URN."""
    return bool(_URN_RE.match(value))


# ─── Parsing ──────────────────────────────────────────────────────────────────

def parse_synodic_urn(urn: str) -> Optional[dict]:
    """
    Attempt to parse a Synodic-format URN into its components.

    Returns a dict with keys ``source_system``, ``entity_type``, ``slug``
    or ``None`` if the URN is not in Synodic format.
    """
    norm = normalize_urn(urn)
    if not norm.startswith(SYNODIC_PREFIX + ":"):
        return None
    rest = norm[len(SYNODIC_PREFIX) + 1:]   # strip "urn:synodic:"
    parts = rest.split(":", 2)               # [source_system, entity_type, slug]
    if len(parts) < 3:
        return None
    return {
        "source_system": parts[0],
        "entity_type": parts[1],
        "slug": parts[2],
    }
