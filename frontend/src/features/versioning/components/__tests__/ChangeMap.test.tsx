/**
 * The Map draws what a review changes: each changed entity, the relationships added or removed,
 * the entities they hang off (as context) — and says when it shows only part of a large review.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { StagedChange } from '@/store/stagedChangesStore'
import { buildReviewGroups } from '../../model/reviewModel'
import ChangeMap, { MAX_NODES } from '../ChangeMap'

const names: Record<string, string> = { 'urn:a': 'Orders', 'urn:b': 'Sales' }
const nameOf = (id: string) => names[id] ?? id

const change = (over: Partial<StagedChange>): StagedChange => ({
  id: Math.random().toString(36), type: 'update_entity', targetId: 'urn:a', targetUrn: 'urn:a', after: {}, summary: 's', timestamp: 0, ...over,
})

describe('ChangeMap', () => {
  it('draws the changed entity, and a new link with the entity it ends at as context', () => {
    const groups = buildReviewGroups([
      change({ before: { label: 'Orders', properties: { a: 1 } }, after: { label: 'Orders', properties: { a: 2 } } }),
      change({ type: 'create_edge', targetId: 'e1', targetUrn: undefined, after: { source: 'urn:a', target: 'urn:b', edgeType: 'FEEDS' } }),
    ], { nameOf })
    render(<ChangeMap groups={groups} nameOf={nameOf} />)
    expect(screen.getByText('Orders')).toBeInTheDocument()
    expect(screen.getByText('Sales')).toBeInTheDocument()
    expect(screen.getByText('Unchanged')).toBeInTheDocument()
    expect(screen.getByText('not saved')).toBeInTheDocument()
  })

  it('says when a large review is drawn only in part', () => {
    const groups = buildReviewGroups(Array.from({ length: MAX_NODES + 5 }, (_, i) =>
      change({ targetId: `urn:n${i}`, targetUrn: `urn:n${i}`, before: { label: `n${i}`, properties: { a: 1 } }, after: { label: `n${i}`, properties: { a: 2 } } })), { nameOf })
    render(<ChangeMap groups={groups} nameOf={nameOf} />)
    expect(screen.getByText(`Showing ${MAX_NODES} of ${MAX_NODES + 5} — the List has them all`)).toBeInTheDocument()
  })

  it('has nothing to draw for layout-only changes, and says so', () => {
    const groups = buildReviewGroups([change({ type: 'layer_config', targetId: 'l' })], { nameOf })
    render(<ChangeMap groups={groups} nameOf={nameOf} />)
    expect(screen.getByText(/layout only/)).toBeInTheDocument()
  })
})
