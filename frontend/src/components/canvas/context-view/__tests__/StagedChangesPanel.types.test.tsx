/**
 * Review & Save lists EVERY staged change. Its section list once left out `update_entity` (every
 * multi-field edit from the drawer) and `move_entity` — staged and saved, never shown for review.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { StagedChangesPanel } from '../StagedChangesPanel'
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
    for (const type of ALL) expect(screen.getByText(`summary of ${type}`)).toBeTruthy()
  })
})
