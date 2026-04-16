"""
Pydantic request/response schemas for the aggregation API.

These live inside the aggregation package so the package is self-contained.
The thin FastAPI adapter (app/api/v1/endpoints/aggregation.py) imports from here.
"""
from typing import List, Optional
from pydantic import BaseModel, Field


# ── Requests ─────────────────────────────────────────────────────────


class AggregationTriggerRequest(BaseModel):
    ontology_id: Optional[str] = Field(None, alias="ontologyId")
    projection_mode: str = Field("in_source", alias="projectionMode")
    batch_size: int = Field(5000, alias="batchSize", ge=100, le=50000)
    # Phase 2 §2.2 — caller-supplied idempotency token. Two POSTs sharing
    # this key for the same data source within the past 60 minutes
    # collapse to the original job (200 OK with the existing job ID).
    # No key supplied → unique-per-call semantics, may 409 on dup.
    idempotency_key: Optional[str] = Field(
        None,
        alias="idempotencyKey",
        max_length=255,
    )

    class Config:
        populate_by_name = True


class AggregationSkipRequest(BaseModel):
    confirmed: bool = False  # must be True to skip

    class Config:
        populate_by_name = True


class AggregationScheduleRequest(BaseModel):
    cron_expression: Optional[str] = Field(None, alias="cronExpression")  # null = disable

    class Config:
        populate_by_name = True


class InternalTriggerRequest(BaseModel):
    """Used by the viz-service proxy to send pre-resolved trigger data
    to the Control Plane.

    Ontology resolution happens in the viz-service (which has OntologyORM
    access) so the Control Plane never needs to import OntologyORM.
    All fields are frozen into the job record at trigger time.
    """
    data_source_id: str = Field(alias="dataSourceId")
    workspace_id: str = Field(alias="workspaceId")
    ontology_id: str = Field(alias="ontologyId")
    containment_edge_types: List[str] = Field(alias="containmentEdgeTypes")
    lineage_edge_types: List[str] = Field(alias="lineageEdgeTypes")
    provider_id: str = Field(alias="providerId")
    graph_name: str = Field(alias="graphName")
    projection_mode: str = Field("in_source", alias="projectionMode")
    batch_size: int = Field(5000, alias="batchSize", ge=100, le=50000)
    trigger_source: str = Field("manual", alias="triggerSource")
    idempotency_key: Optional[str] = Field(None, alias="idempotencyKey", max_length=255)

    class Config:
        populate_by_name = True


# ── Responses ────────────────────────────────────────────────────────


class AggregationJobResponse(BaseModel):
    id: str
    data_source_id: str = Field(alias="dataSourceId")
    status: str
    trigger_source: str = Field(alias="triggerSource")
    progress: int  # 0-100
    total_edges: int = Field(alias="totalEdges")
    processed_edges: int = Field(alias="processedEdges")
    created_edges: int = Field(alias="createdEdges")
    batch_size: int = Field(alias="batchSize")
    last_checkpoint_at: Optional[str] = Field(None, alias="lastCheckpointAt")
    resumable: bool  # True if status is 'failed' and retries remaining
    retry_count: int = Field(alias="retryCount")
    error_message: Optional[str] = Field(None, alias="errorMessage")
    estimated_completion_at: Optional[str] = Field(None, alias="estimatedCompletionAt")
    started_at: Optional[str] = Field(None, alias="startedAt")
    completed_at: Optional[str] = Field(None, alias="completedAt")
    updated_at: Optional[str] = Field(None, alias="updatedAt")
    created_at: str = Field(alias="createdAt")

    # Enrichment fields — populated by global listing endpoint, None for per-DS endpoints
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    workspace_name: Optional[str] = Field(None, alias="workspaceName")
    data_source_label: Optional[str] = Field(None, alias="dataSourceLabel")
    projection_mode: Optional[str] = Field(None, alias="projectionMode")
    duration_seconds: Optional[float] = Field(None, alias="durationSeconds")
    edge_coverage_pct: Optional[float] = Field(None, alias="edgeCoveragePct")

    class Config:
        populate_by_name = True


class PaginatedJobsResponse(BaseModel):
    items: List[AggregationJobResponse]
    total: int
    limit: int
    offset: int

    class Config:
        populate_by_name = True


class DataSourceReadinessResponse(BaseModel):
    data_source_id: str = Field(alias="dataSourceId")
    is_ready: bool = Field(alias="isReady")
    aggregation_status: str = Field(alias="aggregationStatus")
    can_create_views: bool = Field(alias="canCreateViews")
    active_job: Optional[AggregationJobResponse] = Field(None, alias="activeJob")
    drift_detected: bool = Field(False, alias="driftDetected")
    last_aggregated_at: Optional[str] = Field(None, alias="lastAggregatedAt")
    aggregation_edge_count: int = Field(0, alias="aggregationEdgeCount")
    message: str

    class Config:
        populate_by_name = True


class DriftCheckResponse(BaseModel):
    drift_detected: bool = Field(alias="driftDetected")
    current_fingerprint: Optional[str] = Field(None, alias="currentFingerprint")
    stored_fingerprint: Optional[str] = Field(None, alias="storedFingerprint")
    last_checked_at: Optional[str] = Field(None, alias="lastCheckedAt")

    class Config:
        populate_by_name = True
