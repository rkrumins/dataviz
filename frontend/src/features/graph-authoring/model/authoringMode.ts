/**
 * authoringMode — the single discriminated-union state for the canvas authoring
 * controller, plus the pure decisions over it. Replaces the scattered
 * creation-state flags + the separate edge-connect state machine with one mode.
 *
 * Node/edge *editing* is deliberately NOT a mode here — it stays selection-
 * driven (the entity drawer / edge panel via the canvas store), so this union
 * only models the transient authoring gestures.
 */
import type { AllowedEdgeOption } from './ontologyGuard'

export type AuthoringMode =
  | { kind: 'idle' }
  /** Inline ghost-card create inside a layer column (optionally under a parent). */
  | { kind: 'inline-create'; layerId: string; parentId: string | null }
  /** Drawing a RAW edge from `sourceId` — by drag handle or armed click. */
  | { kind: 'connect'; sourceId: string; via: 'drag' | 'armed'; pointer: { x: number; y: number } | null; hoverTargetId: string | null }
  /** Endpoints resolved — the edge-type picker is open at `position`. */
  | { kind: 'edge-type-pick'; sourceId: string; targetId: string; position: { x: number; y: number } }
  /** The hierarchy composer is open (right rail), seeded under a node/layer. */
  | { kind: 'compose'; seedParentId: string | null; seedLayerId: string | null }
  /** The detailed create panel is open (right rail), optionally seeded from the
   *  inline card's "Details…" escalation. */
  | { kind: 'create-panel'; parentId: string | null; layerId: string | null; seedEntityType?: string; seedDisplayName?: string }

export const IDLE: AuthoringMode = { kind: 'idle' }

export const isAuthoringActive = (mode: AuthoringMode): boolean => mode.kind !== 'idle'

export interface ConnectResolution {
  action: 'pick' | 'reject'
  /** Present on reject when the target was a node but no edge type is allowed. */
  reason?: string
}

/**
 * Decide what happens when a connect gesture resolves a target. Opens the edge-
 * type picker only when at least one drawable edge type is allowed for the
 * (source, target) pair; otherwise rejects — with an explanatory reason when the
 * target was a valid node but ontology forbids every edge between the two types.
 */
export function decideConnectResolution(
  sourceId: string,
  targetId: string | null,
  options: AllowedEdgeOption[],
): ConnectResolution {
  if (!targetId || targetId === sourceId) return { action: 'reject' }
  if (options.some((o) => o.allowed)) return { action: 'pick' }
  if (options.length > 0) {
    const reason = options.find((o) => o.reason)?.reason
      ?? 'No edge type in the ontology connects these two entity types.'
    return { action: 'reject', reason }
  }
  return { action: 'reject', reason: 'No drawable lineage edge types are defined in the ontology.' }
}
