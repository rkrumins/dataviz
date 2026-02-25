"""
Standardized response envelopes for all API endpoints.
Provides consistent error format and pagination structure.
Compatible with Pydantic V2.
"""
from typing import Generic, List, Optional, TypeVar, Any, Dict
from pydantic import BaseModel, Field

T = TypeVar("T")


class ErrorDetail(BaseModel):
    code: str
    message: str
    request_id: Optional[str] = Field(None, alias="requestId")
    details: Optional[Dict[str, Any]] = None

    model_config = {"populate_by_name": True}


class ErrorResponse(BaseModel):
    error: ErrorDetail

    @classmethod
    def make(
        cls,
        code: str,
        message: str,
        request_id: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> "ErrorResponse":
        return cls(
            error=ErrorDetail(
                code=code,
                message=message,
                request_id=request_id,
                details=details,
            )
        )

    model_config = {"populate_by_name": True}


class PaginatedResponse(BaseModel, Generic[T]):
    items: List[T]
    total: int
    offset: int
    limit: int
    has_more: bool = Field(alias="hasMore")

    @classmethod
    def make(
        cls, items: List[T], total: int, offset: int, limit: int
    ) -> "PaginatedResponse[T]":
        return cls(
            items=items,
            total=total,
            offset=offset,
            limit=limit,
            has_more=(offset + len(items)) < total,
        )

    model_config = {"populate_by_name": True}


class ErrorCode:
    NOT_FOUND = "NOT_FOUND"
    CONNECTION_NOT_FOUND = "CONNECTION_NOT_FOUND"
    PROVIDER_ERROR = "PROVIDER_ERROR"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    ONTOLOGY_NOT_FOUND = "ONTOLOGY_NOT_FOUND"
    RULE_SET_NOT_FOUND = "RULE_SET_NOT_FOUND"
    VIEW_NOT_FOUND = "VIEW_NOT_FOUND"
    PRIMARY_CONNECTION_REQUIRED = "PRIMARY_CONNECTION_REQUIRED"
    INTERNAL_ERROR = "INTERNAL_ERROR"
