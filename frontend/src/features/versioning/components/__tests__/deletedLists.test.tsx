/**
 * Deletions in the change lists read as they do on the canvas: the name struck through, a deleted
 * link by its two ends' names rather than its type or raw ids, and a Deleted chip that says the
 * word even where it shows only the bin.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CascadeImpactList } from '../CascadeImpactList'
import { ChangesPanel } from '../ChangesPanel'
import { DeletedChip } from '../NodeDiffBadge'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'

describe('DeletedChip', () => {
  it('says Deleted, in words or to a screen reader beside the bin', () => {
    const { rerender } = render(<DeletedChip />)
    expect(screen.getByText('Deleted')).toBeVisible()
    rerender(<DeletedChip compact />)
    expect(screen.getByText('Deleted')).toHaveClass('sr-only')
  })
})

describe('CascadeImpactList', () => {
  it('names a relationship by the entities it joined, striking those that went too', () => {
    render(<CascadeImpactList rootUrn="urn:orders" impact={{
      nodeTotal: 2, edgeTotal: 1,
      nodes: [
        { entityId: 'e-orders', urn: 'urn:orders', displayName: 'Orders' },
        { entityId: 'e-id', urn: 'urn:order_id', displayName: 'Order ID' },
      ],
      edges: [{ entityId: 'edge-1', edgeType: 'FLOWS_TO', sourceEntityId: 'e-id', targetEntityId: 'e-elsewhere-123' }],
    }} />)
    expect(screen.getAllByText('Order ID').at(-1)).toHaveClass('line-through')
    expect(screen.getByText('e-elsewhere-123')).toBeInTheDocument()   // an end the impact doesn't list: its id
    expect(screen.getByText('e-elsewhere-123')).not.toHaveClass('line-through')   // and it stays
  })
})

describe('ChangesPanel', () => {
  const origin = { source: 'branch', branchId: 'b' } as const
  const changes: GraphChange[] = [
    { entityId: 'urn:a', urn: 'urn:a', kind: 'node', status: 'removed', label: 'Orders', origin },
    { entityId: 'edge-1', kind: 'edge', status: 'removed', label: 'FLOWS_TO', origin,
      before: { edgeType: 'FLOWS_TO', sourceEntityId: 'urn:a', targetEntityId: 'urn:far-away-entity' } },
  ] as GraphChange[]

  it('strikes deleted names and names a deleted link by its ends', () => {
    render(<ChangesPanel changeSet={buildChangeSet(changes)} />)
    expect(screen.getByText('Orders')).toHaveClass('line-through')
    const link = screen.getByText('FLOWS_TO · Orders → urn:far-away-entity')
    expect(link).toHaveClass('line-through')
  })
})
