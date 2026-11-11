"""How long a merged or abandoned draft keeps its changes before the versioning worker removes them.

A system administrator sets it live (``/admin/versioning/draft-retention``, Admin → Infrastructure
→ Versioned graphs → Draft retention). It is stored on the single ``platform_settings`` row
(``gv_draft_retention_days``); NULL there means unset, and ``GRAPHVER_DRAFT_RETENTION_DAYS``
applies (30). ``0`` keeps every draft's changes for good.

:func:`retention_days` is what the worker's sweep reads, once a pass. When the row cannot be read it
answers None, and the pass removes nothing: falling back to the default could remove what an
administrator chose to keep.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from . import config

logger = logging.getLogger(__name__)

#: The days a window may be: 0 (keep for good) to ten years.
MIN_DAYS, MAX_DAYS = 0, 3650


def effective(saved: Optional[int]) -> int:
    """The window in force for ``saved`` (None: the environment's default), within range."""
    days = config.DRAFT_RETENTION_DAYS if saved is None else saved
    return max(MIN_DAYS, min(MAX_DAYS, int(days)))


def describe(row) -> Dict[str, Any]:
    """The window as the admin card shows it: ``days`` in force, ``saved`` (None: the default
    applies), ``default``, and the range a value may take."""
    saved = getattr(row, "gv_draft_retention_days", None) if row is not None else None
    return {"days": effective(saved), "saved": saved, "default": effective(None),
            "min": MIN_DAYS, "max": MAX_DAYS}


async def retention_days() -> Optional[int]:
    """The window in force, read now from the management database; None when it cannot be read."""
    from backend.app.db.engine import get_readonly_session
    from backend.app.db.models import PlatformSettingsORM

    try:
        async with get_readonly_session() as s:
            row = await s.get(PlatformSettingsORM, 1)
    except Exception:  # noqa: BLE001 — unread is not the default: nothing is removed this pass
        logger.warning("draft retention could not be read; no draft's changes are removed this pass",
                       exc_info=True)
        return None
    return describe(row)["days"]
