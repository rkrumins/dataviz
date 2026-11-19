/**
 * Review & Save lists EVERY staged change. Its section list once left out `update_entity` (every
 * multi-field edit from the drawer) and `move_entity` — staged and saved, never shown for review.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StagedChangesPanel } from '../StagedChangesPanel'

// jsdom has no layout: lay every row of the virtualized list out.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 52, size: 52,
    })),
    getTotalSize: () => opts.count * 52,
    scrollToIndex: () => undefined,
  }),
}))
import { useStagedChangesStore, type StagedChange, type StagedChangeType } from '@/store/stagedChangesStore'

const ALL: StagedChangeType[] = [
  'create_entity', 'rename_entity', 'update_entity', 'delete_entity', 'assign_layer', 'move_to_layer',
  'create_edge', 'edit_edge', 'delete_edge', 'reverse_edge', 'move_entity', 'layer_config', 'reorder_nodes',
]

describe('Review & Save', () => {
  beforeEach(() => {
    const changes: StagedChange[] = ALL.map((type, i) => ({
      id: `c${i}`, type, targetId: `t${i}`, after: {}, summary: `summary of ${type}`, timestamp: Date.now(),
    }))
    useStagedChangesStore.setState({ changes, redoStack: [], isReviewPanelOpen: true } as never)
  })

  it('shows a row for every kind of staged change', () => {
    render(<StagedChangesPanel onConfirm={() => {}} />)
    for (const type of ALL) expect(screen.getAllByText(`summary of ${type}`).length).toBeGreaterThan(0)
  })

  it('words a change from the current state when the host says it changed (a group moved layer)', () => {
    const describe = (c: StagedChange) => (c.type === 'assign_layer' ? "Place 'X' in group “Outer” (Layer 3)" : undefined)
    render(<StagedChangesPanel onConfirm={() => {}} describe={describe} />)
    expect(screen.getAllByText("Place 'X' in group “Outer” (Layer 3)").length).toBeGreaterThan(0)
    expect(screen.queryByText('summary of assign_layer')).toBeNull()
    expect(screen.getAllByText('summary of move_to_layer').length).toBeGreaterThan(0)   // the rest keep their summary
  })
})

