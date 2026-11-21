"""
Repository for graph_connections table.
All credential handling (encryption/decryption) lives here.
"""
import json
import logging
import os
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import GraphConnectionORM
from backend.common import credential_crypto
from backend.common.models.management import (
    ConnectionCreateRequest,
    ConnectionUpdateRequest,
    ConnectionResponse,
    ProviderType,
)

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ #
# Credential encryption (Fernet symmetric)                             #
# ------------------------------------------------------------------ #

# The implementation lives in ``backend.common.credential_crypto`` so the AI
# service shares it without importing the ORM; these are the names this
# module's importers have always used.
_PROD_ENV_VALUES = credential_crypto._PROD_ENV_VALUES
CredentialEncryptionError = credential_crypto.CredentialEncryptionError
require_encryption_or_plaintext_ok = credential_crypto.require_encryption_or_plaintext_ok
_get_fernet = credential_crypto.get_fernet
_encrypt = credential_crypto.encrypt
_decrypt = credential_crypto.decrypt


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                            #
# ------------------------------------------------------------------ #

def _to_response(row: GraphConnectionORM) -> ConnectionResponse:
    return ConnectionResponse(
        id=row.id,
        name=row.name,
        providerType=row.provider_type,
        host=row.host,
        port=row.port,
        graphName=row.graph_name,
        tlsEnabled=bool(row.tls_enabled),
        isPrimary=bool(getattr(row, "is_primary", False)),
        isActive=bool(row.is_active),
        extraConfig=json.loads(row.extra_config) if row.extra_config else None,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_connections(session: AsyncSession) -> List[ConnectionResponse]:
    result = await session.execute(
        select(GraphConnectionORM).order_by(GraphConnectionORM.created_at)
    )
    return [_to_response(r) for r in result.scalars().all()]


async def get_connection(
    session: AsyncSession, connection_id: str
) -> Optional[ConnectionResponse]:
    result = await session.execute(
        select(GraphConnectionORM).where(GraphConnectionORM.id == connection_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def get_connection_orm(
    session: AsyncSession, connection_id: str
) -> Optional[GraphConnectionORM]:
    """Return the raw ORM row (used by ProviderRegistry for connection params)."""
    result = await session.execute(
        select(GraphConnectionORM).where(GraphConnectionORM.id == connection_id)
    )
    return result.scalar_one_or_none()


async def create_connection(
    session: AsyncSession,
    req: ConnectionCreateRequest,
    make_primary: bool = False,
) -> ConnectionResponse:
    # Global "primary connection" semantics were removed. Keep the argument for
    # backward compatibility with older call sites, but ignore it at runtime.
    _ = make_primary
    creds_blob = _encrypt(req.credentials.model_dump() if req.credentials else {})
    row = GraphConnectionORM(
        name=req.name,
        provider_type=req.provider_type.value,
        host=req.host,
        port=req.port,
        graph_name=req.graph_name,
        credentials=creds_blob,
        tls_enabled=req.tls_enabled,
        is_active=True,
        extra_config=json.dumps(req.extra_config) if req.extra_config else None,
    )
    session.add(row)
    await session.flush()
    return _to_response(row)


async def update_connection(
    session: AsyncSession,
    connection_id: str,
    req: ConnectionUpdateRequest,
) -> Optional[ConnectionResponse]:
    row = await get_connection_orm(session, connection_id)
    if not row:
        return None

    if req.name is not None:
        row.name = req.name
    if req.host is not None:
        row.host = req.host
    if req.port is not None:
        row.port = req.port
    if req.graph_name is not None:
        row.graph_name = req.graph_name
    if req.credentials is not None:
        row.credentials = _encrypt(req.credentials.model_dump())
    if req.tls_enabled is not None:
        row.tls_enabled = req.tls_enabled
    if req.is_active is not None:
        row.is_active = req.is_active
    if req.extra_config is not None:
        row.extra_config = json.dumps(req.extra_config)

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_connection(
    session: AsyncSession, connection_id: str
) -> bool:
    result = await session.execute(
        delete(GraphConnectionORM).where(GraphConnectionORM.id == connection_id)
    )
    return result.rowcount > 0


async def get_credentials(
    session: AsyncSession, connection_id: str
) -> dict:
    """Return decrypted credentials for a connection (internal use only)."""
    row = await get_connection_orm(session, connection_id)
    if not row:
        return {}
    return _decrypt(row.credentials)
