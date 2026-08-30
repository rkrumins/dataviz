"""Bulk-CREATE operator knobs.

Moved unchanged from the pre-class section of the former
``falkordb_provider.py`` (lines 72-132 as of the package move).
"""
import os
from typing import Tuple

from backend.app.providers.falkordb._log import logger

# Bulk-CREATE operator knobs — defaults shared with the class attributes.
_BULK_CREATE_BATCH_DEFAULT = 10000
_BULK_CREATE_TIMEOUT_DEFAULT = 60.0
# Parsed-knob memo keyed by the RAW env values, so the parse (and its
# operator-tuning log line) happens once per process per configuration —
# not once per provider construction, which at fleet scale (discovery
# transients, cache rebuilds) repeated the same line on every request.
_BULK_CREATE_KNOBS_CACHE: dict = {}


def _resolve_bulk_create_knobs() -> Tuple[int, float]:
    """(batch_size, timeout_s) for bulk-CREATE, env-tuned with clamps.

    Batch size: FalkorDB best practice is 10k-50k rows per UNWIND; the env
    dial lets operators shrink it where the default monopolizes the single
    Cypher thread under concurrent trace load. Timeout: bulk writes need more
    headroom than incremental MERGEs; ceiling stays below the server's
    TIMEOUT_MAX (180s in the shipped FALKORDB_ARGS) or FalkorDB rejects the
    per-query timeout and the write becomes unkillable server-side.
    """
    raw = (
        os.getenv("FALKORDB_BULK_CREATE_BATCH_SIZE"),
        os.getenv("FALKORDB_BULK_CREATE_TIMEOUT_S"),
    )
    if raw in _BULK_CREATE_KNOBS_CACHE:
        return _BULK_CREATE_KNOBS_CACHE[raw]

    size = _BULK_CREATE_BATCH_DEFAULT
    if raw[0] is not None:
        try:
            size = max(100, min(50000, int(raw[0])))
            if size != _BULK_CREATE_BATCH_DEFAULT:
                logger.info(
                    "FALKORDB_BULK_CREATE_BATCH_SIZE=%s (clamped to %d, "
                    "default %d): operator-tuned bulk-CREATE batch size.",
                    raw[0], size, _BULK_CREATE_BATCH_DEFAULT,
                )
        except ValueError:
            logger.warning(
                "FALKORDB_BULK_CREATE_BATCH_SIZE=%r is not an integer; "
                "falling back to default %d.", raw[0], _BULK_CREATE_BATCH_DEFAULT,
            )

    timeout_s = _BULK_CREATE_TIMEOUT_DEFAULT
    if raw[1] is not None:
        try:
            timeout_s = max(5.0, min(170.0, float(raw[1])))
            if timeout_s != _BULK_CREATE_TIMEOUT_DEFAULT:
                logger.info(
                    "FALKORDB_BULK_CREATE_TIMEOUT_S=%s (clamped to %.1fs, "
                    "default %.1fs): operator-tuned bulk-CREATE write timeout.",
                    raw[1], timeout_s, _BULK_CREATE_TIMEOUT_DEFAULT,
                )
        except ValueError:
            logger.warning(
                "FALKORDB_BULK_CREATE_TIMEOUT_S=%r is not a float; "
                "falling back to default %.1fs.", raw[1], _BULK_CREATE_TIMEOUT_DEFAULT,
            )

    _BULK_CREATE_KNOBS_CACHE[raw] = (size, timeout_s)
    return _BULK_CREATE_KNOBS_CACHE[raw]
