import { authFetch } from './apiClient';

export interface AggregationTriggerRequest {
  ontologyId?: string;
  projectionMode: string;
  batchSize: number;
}

export interface AggregationSkipRequest {
  confirmed: boolean;
}

export interface AggregationScheduleRequest {
  cronExpression: string | null;
}

export interface AggregationJobResponse {
  id: string;
  dataSourceId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggerSource: string;
  progress: number;
  totalEdges: number;
  processedEdges: number;
  createdEdges: number;
  batchSize: number;
  lastCheckpointAt?: string;
  resumable: boolean;
  retryCount: number;
  errorMessage?: string;
  estimatedCompletionAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  createdAt: string;
  // Enrichment fields — populated by global listing endpoint
  workspaceId?: string;
  workspaceName?: string;
  dataSourceLabel?: string;
  projectionMode?: string;
  durationSeconds?: number;
  edgeCoveragePct?: number;
}

export interface PaginatedJobsResponse {
  items: AggregationJobResponse[];
  total: number;
  limit: number;
  offset: number;
}

export interface JobHistoryFilters {
  status?: string[];
  workspaceId?: string;
  dataSourceId?: string[];
  projectionMode?: string;
  triggerSource?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

export interface DataSourceReadinessResponse {
  dataSourceId: string;
  isReady: boolean;
  aggregationStatus: 'none' | 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
  canCreateViews: boolean;
  activeJob?: AggregationJobResponse;
  driftDetected: boolean;
  lastAggregatedAt?: string;
  aggregationEdgeCount: number;
  message: string;
}

export interface DriftCheckResponse {
  driftDetected: boolean;
  currentFingerprint?: string;
  storedFingerprint?: string;
  lastCheckedAt?: string;
}

export interface JobsSummary {
  total: number;
  byStatus: Record<string, number>;
  successRate: number | null;
  avgDurationSeconds: number | null;
}

class AggregationService {
  async getJobsSummary(): Promise<JobsSummary> {
    return authFetch<JobsSummary>('/api/v1/admin/aggregation-jobs/summary');
  }

  async triggerAggregation(
    dataSourceId: string,
    request: AggregationTriggerRequest,
    triggerSource: 'manual' | 'onboarding' = 'manual'
  ): Promise<AggregationJobResponse> {
    return authFetch<AggregationJobResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs?triggerSource=${triggerSource}`,
      {
        method: 'POST',
        body: JSON.stringify(request),
      }
    );
  }

  async getReadiness(dataSourceId: string): Promise<DataSourceReadinessResponse> {
    return authFetch<DataSourceReadinessResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/readiness`
    );
  }

  async listJobs(dataSourceId: string, status?: string): Promise<AggregationJobResponse[]> {
    const query = status ? `?status=${status}` : '';
    return authFetch<AggregationJobResponse[]>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs${query}`
    );
  }

  async getJob(dataSourceId: string, jobId: string): Promise<AggregationJobResponse> {
    return authFetch<AggregationJobResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs/${jobId}`
    );
  }

  async resumeJob(dataSourceId: string, jobId: string): Promise<AggregationJobResponse> {
    return authFetch<AggregationJobResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs/${jobId}/resume`,
      { method: 'POST' }
    );
  }

  async cancelJob(dataSourceId: string, jobId: string): Promise<AggregationJobResponse> {
    return authFetch<AggregationJobResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-jobs/${jobId}/cancel`,
      { method: 'POST' }
    );
  }

  async deleteJob(jobId: string): Promise<void> {
    return authFetch<void>(
      `/api/v1/admin/aggregation-jobs/${jobId}`,
      { method: 'DELETE' }
    );
  }

  async purgeAggregation(dataSourceId: string): Promise<{ deletedEdges: number; dataSourceId: string }> {
    return authFetch<{ deletedEdges: number; dataSourceId: string }>(
      `/api/v1/admin/data-sources/${dataSourceId}/purge-aggregation`,
      { method: 'POST' }
    );
  }

  async skipAggregation(dataSourceId: string): Promise<DataSourceReadinessResponse> {
    return authFetch<DataSourceReadinessResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/skip-aggregation`,
      {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      }
    );
  }

  async setSchedule(dataSourceId: string, cronExpression: string | null): Promise<void> {
    return authFetch<void>(
      `/api/v1/admin/data-sources/${dataSourceId}/aggregation-schedule`,
      {
        method: 'PUT',
        body: JSON.stringify({ cronExpression }),
      }
    );
  }

  async listJobsGlobal(filters: JobHistoryFilters = {}): Promise<PaginatedJobsResponse> {
    const params = new URLSearchParams();
    if (filters.status?.length) filters.status.forEach(s => params.append('status', s));
    if (filters.workspaceId) params.set('workspaceId', filters.workspaceId);
    if (filters.dataSourceId?.length) filters.dataSourceId.forEach(id => params.append('dataSourceId', id));
    if (filters.projectionMode) params.set('projectionMode', filters.projectionMode);
    if (filters.triggerSource) params.set('triggerSource', filters.triggerSource);
    if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.set('dateTo', filters.dateTo);
    if (filters.limit) params.set('limit', String(filters.limit));
    if (filters.offset !== undefined) params.set('offset', String(filters.offset));
    const qs = params.toString();
    return authFetch<PaginatedJobsResponse>(
      `/api/v1/admin/aggregation-jobs${qs ? `?${qs}` : ''}`
    );
  }

  async checkDrift(dataSourceId: string): Promise<DriftCheckResponse> {
    return authFetch<DriftCheckResponse>(
      `/api/v1/admin/data-sources/${dataSourceId}/check-drift`
    );
  }
}

export const aggregationService = new AggregationService();
