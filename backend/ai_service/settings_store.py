"""The assistant's run-time settings (``ai_settings``, one row), with defaults.

What an administrator decides under Administration → AI: which connection
serves which role, which personas are on, what may be sent to a model, the
limits per person and how long conversations are kept. NULL in the row means
"unset", and the default below applies — so a fresh deployment is usable the
moment a connection exists.

Read through a short cache: every turn needs the settings, and a change
reaches every replica within :data:`_TTL_SECONDS`.
"""
from __future__ import annotations

import copy
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AiSettingsORM

_TTL_SECONDS = 5.0

DEFAULT_PERSONAS: dict[str, bool] = {"data": True, "help": True}

#: What may leave the platform for a model. Names and types always go — an
#: answer about a dataset cannot be made without its name.
DEFAULT_DATA_POLICY: dict[str, Any] = {
    "sendDescriptions": True,
    "sendPropertyValues": True,
    "sendSampleValues": True,
    #: Rows of any result shown to the model (the person sees them all).
    "maxResultRows": 25,
    #: Regular expressions whose matches are replaced by [redacted] in
    #: anything sent to a model.
    "redactPatterns": [],
}

DEFAULT_LIMITS: dict[str, int] = {
    "maxStepsPerTurn": 8,
    "dailyTokensPerUser": 400_000,
    "maxConcurrentTurnsPerUser": 2,
}

DEFAULT_RETENTION_DAYS = 30

_LIMIT_RANGES = {
    "maxStepsPerTurn": (1, 16),
    "dailyTokensPerUser": (1_000, 50_000_000),
    "maxConcurrentTurnsPerUser": (1, 8),
}


@dataclass(frozen=True)
class AiSettings:
    chat_connection_id: Optional[str] = None
    fast_connection_id: Optional[str] = None
    embedding_connection_id: Optional[str] = None
    personas: Mapping[str, bool] = field(default_factory=lambda: dict(DEFAULT_PERSONAS))
    data_policy: Mapping[str, Any] = field(default_factory=lambda: copy.deepcopy(DEFAULT_DATA_POLICY))
    limits: Mapping[str, int] = field(default_factory=lambda: dict(DEFAULT_LIMITS))
    retention_days: int = DEFAULT_RETENTION_DAYS
    updated_by: Optional[str] = None
    updated_at: Optional[str] = None

    def public(self) -> dict[str, Any]:
        return {
            "chatConnectionId": self.chat_connection_id,
            "fastConnectionId": self.fast_connection_id,
            "embeddingConnectionId": self.embedding_connection_id,
            "personas": dict(self.personas),
            "dataPolicy": dict(self.data_policy),
            "limits": dict(self.limits),
            "retentionDays": self.retention_days,
            "updatedBy": self.updated_by,
            "updatedAt": self.updated_at,
        }


def _merged(raw: Optional[str], default: Mapping[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(dict(default))
    if raw:
        try:
            stored = json.loads(raw)
        except (TypeError, ValueError):
            stored = {}
        if isinstance(stored, dict):
            for key, value in stored.items():
                if key in out:
                    out[key] = value
    return out


def _from_row(row: Optional[AiSettingsORM]) -> AiSettings:
    if row is None:
        return AiSettings()
    return AiSettings(
        chat_connection_id=row.chat_connection_id,
        fast_connection_id=row.fast_connection_id,
        embedding_connection_id=row.embedding_connection_id,
        personas=_merged(row.personas, DEFAULT_PERSONAS),
        data_policy=_merged(row.data_policy, DEFAULT_DATA_POLICY),
        limits=_merged(row.limits, DEFAULT_LIMITS),
        retention_days=row.retention_days or DEFAULT_RETENTION_DAYS,
        updated_by=row.updated_by,
        updated_at=row.updated_at,
    )


_cache: tuple[float, AiSettings] | None = None


def invalidate() -> None:
    global _cache
    _cache = None


async def load(session: AsyncSession) -> AiSettings:
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < _TTL_SECONDS:
        return _cache[1]
    row = (await session.execute(select(AiSettingsORM).where(AiSettingsORM.id == 1))).scalar_one_or_none()
    settings = _from_row(row)
    _cache = (now, settings)
    return settings


class SettingsInvalid(ValueError):
    pass


def _validate_patch(patch: Mapping[str, Any]) -> dict[str, Any]:
    import re

    out: dict[str, Any] = {}
    for key in ("chatConnectionId", "fastConnectionId", "embeddingConnectionId"):
        if key in patch:
            value = patch[key]
            if value is not None and not isinstance(value, str):
                raise SettingsInvalid(f"{key} must be a connection id or null.")
            out[key] = value or None
    if "personas" in patch:
        personas = patch["personas"]
        if not isinstance(personas, Mapping) or not set(personas) <= set(DEFAULT_PERSONAS):
            raise SettingsInvalid(f"personas may only set {sorted(DEFAULT_PERSONAS)}.")
        out["personas"] = {k: bool(v) for k, v in personas.items()}
    if "dataPolicy" in patch:
        policy = patch["dataPolicy"]
        if not isinstance(policy, Mapping) or not set(policy) <= set(DEFAULT_DATA_POLICY):
            raise SettingsInvalid(f"dataPolicy may only set {sorted(DEFAULT_DATA_POLICY)}.")
        clean: dict[str, Any] = {}
        for key, value in policy.items():
            if key == "maxResultRows":
                clean[key] = max(1, min(200, int(value)))
            elif key == "redactPatterns":
                if not isinstance(value, list) or len(value) > 32:
                    raise SettingsInvalid("redactPatterns must be a list of at most 32 patterns.")
                for pattern in value:
                    try:
                        re.compile(str(pattern))
                    except re.error as exc:
                        raise SettingsInvalid(f"{pattern!r} is not a valid pattern: {exc}") from exc
                clean[key] = [str(p) for p in value]
            else:
                clean[key] = bool(value)
        out["dataPolicy"] = clean
    if "limits" in patch:
        limits = patch["limits"]
        if not isinstance(limits, Mapping) or not set(limits) <= set(DEFAULT_LIMITS):
            raise SettingsInvalid(f"limits may only set {sorted(DEFAULT_LIMITS)}.")
        out["limits"] = {
            k: max(_LIMIT_RANGES[k][0], min(_LIMIT_RANGES[k][1], int(v))) for k, v in limits.items()
        }
    if "retentionDays" in patch:
        out["retentionDays"] = max(1, min(3650, int(patch["retentionDays"])))
    return out


async def save(session: AsyncSession, patch: Mapping[str, Any], *, user_id: str) -> AiSettings:
    """Merge *patch* (the public shape) into the row; validated first."""
    clean = _validate_patch(patch)
    row = (await session.execute(select(AiSettingsORM).where(AiSettingsORM.id == 1))).scalar_one_or_none()
    if row is None:
        row = AiSettingsORM(id=1)
        session.add(row)
    current = _from_row(row)
    if "chatConnectionId" in clean:
        row.chat_connection_id = clean["chatConnectionId"]
    if "fastConnectionId" in clean:
        row.fast_connection_id = clean["fastConnectionId"]
    if "embeddingConnectionId" in clean:
        row.embedding_connection_id = clean["embeddingConnectionId"]
    if "personas" in clean:
        row.personas = json.dumps({**current.personas, **clean["personas"]})
    if "dataPolicy" in clean:
        row.data_policy = json.dumps({**current.data_policy, **clean["dataPolicy"]})
    if "limits" in clean:
        row.limits = json.dumps({**current.limits, **clean["limits"]})
    if "retentionDays" in clean:
        row.retention_days = clean["retentionDays"]
    row.updated_by = user_id
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    invalidate()
    return _from_row(row)
