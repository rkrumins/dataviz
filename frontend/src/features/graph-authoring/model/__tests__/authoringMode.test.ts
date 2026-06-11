import { describe, it, expect } from 'vitest'
import {
  IDLE,
  isAuthoringActive,
  decideConnectResolution,
  type AuthoringMode,
} from '../authoringMode'
import type { AllowedEdgeOption } from '../ontologyGuard'

const opt = (edgeType: string, allowed: boolean): AllowedEdgeOption => ({ edgeType, label: edgeType, allowed })

describe('isAuthoringActive', () => {
  it('is false for idle and true for every authoring mode', () => {
    expect(isAuthoringActive(IDLE)).toBe(false)
    const active: AuthoringMode[] = [
      { kind: 'inline-create', layerId: 'L', parentId: null },
      { kind: 'connect', sourceId: 's', via: 'drag', pointer: null, hoverTargetId: null },
      { kind: 'edge-type-pick', sourceId: 's', targetId: 't', position: { x: 0, y: 0 } },
      { kind: 'compose', seedParentId: null, seedLayerId: 'L' },
      { kind: 'create-panel', parentId: null, layerId: 'L' },
    ]
    active.forEach((m) => expect(isAuthoringActive(m)).toBe(true))
  })
})

describe('decideConnectResolution', () => {
  it('rejects when the dropped target is not a node, or is the source itself', () => {
    expect(decideConnectResolution('s', null, [opt('FLOWS_TO', true)]).action).toBe('reject')
    expect(decideConnectResolution('s', 's', [opt('FLOWS_TO', true)]).action).toBe('reject')
  })

  it('opens the picker when at least one edge type is allowed for the pair', () => {
    const out = decideConnectResolution('s', 't', [opt('FLOWS_TO', true), opt('PRODUCES', false)])
    expect(out.action).toBe('pick')
  })

  it('rejects with an explanatory reason when options exist but none are allowed', () => {
    const out = decideConnectResolution('s', 't', [opt('PRODUCES', false)])
    expect(out.action).toBe('reject')
    expect(out.reason).toBeTruthy()
  })

  it('rejects when there are no drawable edge types at all', () => {
    expect(decideConnectResolution('s', 't', []).action).toBe('reject')
  })
})
