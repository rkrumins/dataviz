/**
 * Review & Save runs one save at a time. While it runs, a second click must not send the batch
 * again, and the review must not be closed or emptied under it: Esc, the backdrop, X and Cancel
 * leave it open, and nothing can be discarded or undone. When the save settles the panel is idle.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StagedChangesPanel } from '../StagedChangesPanel'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'

const change = (id: string): StagedChange => ({
  id, type: 'rename_entity', targetId: `t-${id}`, after: {}, summary: `rename ${id}`, timestamp: Date.now(),
})

function pendingConfirm() {
  let settle!: () => void
  const onConfirm = vi.fn(() => new Promise<void>((r) => { settle = r }))
  return { onConfirm, settle: async () => { await act(async () => { settle() }) } }
}

const state = () => useStagedChangesStore.getState()

describe('Review & Save while a save is running', () => {
  beforeEach(() => {
    useStagedChangesStore.setState({
      changes: [change('a'), change('b')], redoStack: [change('r')], isReviewPanelOpen: true,
      applyStatus: 'idle', lastApplyResult: null,
    } as never)
  })

  it('sends the batch once, however often Save is pressed', async () => {
    const { onConfirm, settle } = pendingConfirm()
    render(<StagedChangesPanel onConfirm={onConfirm} />)
    const save = screen.getByRole('button', { name: /Save 2 changes/ })
    fireEvent.click(save)
    fireEvent.click(save)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Saving…')).toBeTruthy()
    await settle()
    expect(state().applyStatus).toBe('idle')
  })

  it('cannot be closed, discarded or undone until the save settles', async () => {
    const { onConfirm, settle } = pendingConfirm()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<StagedChangesPanel onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: /Save 2 changes/ }))

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(document.querySelector('[aria-hidden].fixed.inset-0') as Element)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(state().isReviewPanelOpen).toBe(true)

    expect(screen.getByRole('button', { name: 'Discard all' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard all' }))
    for (const b of screen.getAllByRole('button', { name: 'Discard change' })) fireEvent.click(b)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(state().changes.map((c) => c.id)).toEqual(['a', 'b'])
    expect(state().redoStack.map((c) => c.id)).toEqual(['r'])
    expect(state().applyStatus).toBe('applying')

    await settle()
    expect(state().applyStatus).toBe('idle')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(state().isReviewPanelOpen).toBe(false)
    confirmSpy.mockRestore()
  })
})
