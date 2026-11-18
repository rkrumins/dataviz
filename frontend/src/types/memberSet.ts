/**
 * Member sets — `POST /{ws_id}/graph/member-sets` — as the client sends and
 * reads them. Mirrors `backend/common/models/member_set.py`: a membership spec
 * (seeds, and how far they reach) resolved on the server, a step at a time,
 * however large — followed with its `setId` until it is complete, then
 * downloaded or paged.
 */
import type { MembershipCounts, MembershipSpec, MembershipTruncation } from './membership'

export interface MemberSetRequest {
  spec: MembershipSpec
  /** Keep the lineage edges between members too (an edges file, a JSON section). */
  includeEdges?: boolean
  /** Follow a set already started. */
  setId?: string
  /** How long the server works on it before answering (0–30000). */
  waitMs?: number
}

export type MemberSetStage = 'seeds' | 'inside' | 'upstream' | 'downstream' | 'partnerInside' | 'done'

export interface MemberSetStatus {
  setId: string
  specHash: string
  /** `expired`: no longer kept — ask again without its setId. */
  status: 'running' | 'complete' | 'failed' | 'expired'
  stage: MemberSetStage
  counts: MembershipCounts
  missingSeeds: number
  truncated: MembershipTruncation[]
  dataVersion: string
  progress: { steps: number; queued: number }
  startedAt: string
  completedAt?: string | null
  expiresAt?: string | null
  /** Complete only: names the set, and whose it is, for its download. */
  downloadToken?: string | null
}

export type MemberSetFormat = 'csv' | 'ndjson' | 'json'
