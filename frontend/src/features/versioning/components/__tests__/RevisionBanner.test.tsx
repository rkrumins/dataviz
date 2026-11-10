/**
 * RevisionBanner — while a past revision is open on the canvas it says when that was, which revision
 * and whose, and how far the graph has moved on since — up to the head it was opened at, saying when
 * Published has moved on past that; it says "Opening…" until the canvas reads it, and the ways on:
 * compare it with now, restore to it (publishers only), back to Published (or Esc).
 */
import { act, render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBranchStore } from '@/store/branchStore'
import { useReviewStore } from '@/store/reviewStore'

const state = vi.hoisted(() => ({ readAt: 12 as number | null, phase: 'complete', head: 44, since: [] as unknown[] }))

vi.mock('@/providers/ViewExecutionContext', () => ({
  useViewExecutionContext: () => ({ asOfSeq: state.readAt }),
}))
vi.mock('@/store/canvas', () => ({
  useCanvasStore: (sel: (s: unknown) => unknown) => sel({ hydrationPhase: state.phase }),
}))
vi.mock('../../hooks/useVersioning', () => ({
  useRevision: () => ({
    data: {
      commit: { commit_id: 'cmt_12', commit_seq: 12, message: 'Quarter close', actor: 'usr_1', created_at: '2026-10-31T17:42:00Z' },
      userNames: { usr_1: 'Ana Lee' }, headSeq: state.head, changedSince: 12_400, limit: 100_000, openable: true, reason: null,
    },
    isLoading: false,
    error: null,
  }),
  useChangeSummary: (_ws: string, _gid: string, origin: unknown) => {
    state.since.push(origin)
    return {
      data: { counts: { added: 1200, modified: 340, removed: 12 }, window: { commitCount: 32 } },
      isLoading: false,
    }
  },
}))
vi.mock('../RollbackDialogs', () => ({ RestoreDialog: () => null }))

import { RevisionBanner } from '../RevisionBanner'

function open() {
  useBranchStore.getState().reset()
  useBranchStore.getState().openRevision({ seq: 12, headAtOpen: 44 })
}

beforeEach(() => {
  state.readAt = 12
  state.phase = 'complete'
  state.head = 44
  state.since = []
  useReviewStore.setState({ available: false, listOpen: false, scope: null, operation: null })
  open()
})

describe('RevisionBanner', () => {
  it('says when, which revision, whose, and how far the graph has moved on', () => {
    render(<RevisionBanner workspaceId="ws1" graphId="g1" onCompare={() => {}} />)
    expect(screen.getByText(/Viewing Published as it was/)).toBeInTheDocument()
    expect(screen.getByText('Revision #12')).toBeInTheDocument()
    expect(screen.getByText('Quarter close')).toBeInTheDocument()
    expect(screen.getByText('Ana Lee')).toBeInTheDocument()
    expect(screen.getByText('32 revisions')).toBeInTheDocument()
    expect(screen.getByText('+1.2K')).toBeInTheDocument()
    expect(screen.queryByText(/Published has moved on/)).not.toBeInTheDocument()
  })

  it('counts since then up to the head it opened at; once Published moves on it says so, and Update counts up to now', () => {
    state.head = 47
    render(<RevisionBanner workspaceId="ws1" graphId="g1" onCompare={() => {}} />)
    expect(state.since.at(-1)).toEqual({ fromSeq: 12, toSeq: 44 })
    expect(screen.getByText('Published has moved on: 3 newer revisions')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(useBranchStore.getState().revision).toMatchObject({ seq: 12, headAtOpen: 47 })
    expect(state.since.at(-1)).toEqual({ fromSeq: 12, toSeq: 47 })
    expect(screen.queryByText(/Published has moved on/)).not.toBeInTheDocument()
  })

  it('says it is opening until the canvas reads the revision, and rewinding while it draws', () => {
    state.readAt = null
    const { rerender } = render(<RevisionBanner workspaceId="ws1" graphId="g1" onCompare={() => {}} />)
    expect(screen.getByText(/Opening Published as it was/)).toBeInTheDocument()
    state.readAt = 12
    state.phase = 'roots'
    rerender(<RevisionBanner workspaceId="ws1" graphId="g1" onCompare={() => {}} />)
    expect(screen.getByText('Rewinding 12,400 changes…')).toBeInTheDocument()
  })

  it('compares with now, and goes back to Published by button or by Esc', () => {
    const onCompare = vi.fn()
    render(<RevisionBanner workspaceId="ws1" graphId="g1" onCompare={onCompare} />)
    fireEvent.click(screen.getByText('Compare with now'))
    expect(onCompare).toHaveBeenCalledWith(12, null)

    fireEvent.click(screen.getByText('Back to Published'))
    expect(useBranchStore.getState().revision).toBeNull()

    act(() => open())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useBranchStore.getState().revision).toBeNull()
  })

  it('leaves Esc to a dialog that is open, and offers restoring only to publishers', () => {
    const { rerender } = render(<RevisionBanner workspaceId="ws1" graphId="g1" onCompare={() => {}} />)
    expect(screen.queryByLabelText('Restore graph to here')).not.toBeInTheDocument()
    rerender(<RevisionBanner workspaceId="ws1" graphId="g1" canRestore onCompare={() => {}} />)
    expect(screen.getByLabelText('Restore graph to here')).toBeInTheDocument()

    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useBranchStore.getState().revision?.seq).toBe(12)
    dialog.remove()
  })
})

describe('RevisionBanner — on the Context View', () => {
  it('reviews what changed since, by the operation counted', () => {
    useReviewStore.setState({ available: true })
    render(<RevisionBanner workspaceId="ws1" graphId="g1" onCompare={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Review 12 deleted since this revision' }))
    expect(useReviewStore.getState()).toMatchObject({ listOpen: true, scope: { kind: 'since', seq: 12 }, operation: 'removed' })
    fireEvent.click(screen.getByRole('button', { name: 'Review 1,200 added since this revision' }))
    expect(useReviewStore.getState().operation).toBe('added')
  })

  it('only says the counts elsewhere', () => {
    render(<RevisionBanner workspaceId="ws1" graphId="g1" onCompare={() => {}} />)
    expect(screen.getByText('+1.2K')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Review / })).toBeNull()
  })
})
