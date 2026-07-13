/**
 * RollbackDialogs — pins the confirm flows: RevertDialog fires the revert
 * mutation and morphs into the conflict explanation (with the restore-instead
 * escape hatch) on MergeConflictError; RestoreDialog renders the exact preview
 * counts and fires the restore mutation. Mutations + preview are stubbed.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const revertMutate = vi.fn()
const restoreMutate = vi.fn()
let previewState: { data?: unknown; isLoading: boolean } = { data: undefined, isLoading: false }

vi.mock('../../hooks/useVersioning', () => ({
  useRevertCommit: () => ({ mutate: revertMutate, isPending: false }),
  useRestoreCommit: () => ({ mutate: restoreMutate, isPending: false }),
  useRestorePreview: () => previewState,
}))

const showToast = vi.fn()
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ showToast }),
}))

import { MergeConflictError } from '@/services/versioningApiService'
import { RevertDialog, RestoreDialog } from '../RollbackDialogs'

const COMMIT = {
  commit_id: 'cmt_2',
  parent_commit_id: 'cmt_1',
  kind: 'squash_publish',
  message: 'edit wave',
  actor: 'alice',
  created_at: '2026-07-12T10:00:00Z',
  stats: { create: 1, update: 2, delete: 0 },
}

beforeEach(() => {
  vi.clearAllMocks()
  previewState = { data: undefined, isLoading: false }
})

describe('RevertDialog', () => {
  it('confirms in plain language and fires the revert mutation', () => {
    render(
      <RevertDialog open commit={COMMIT} wsId="ws1" graphId="g1" onClose={() => {}} />,
    )
    expect(screen.getByText('Undo this change?')).toBeInTheDocument()
    expect(screen.getByText('edit wave')).toBeInTheDocument()
    expect(screen.getByText(/Later changes are kept/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Undo change/ }))
    expect(revertMutate).toHaveBeenCalledWith(
      { commitId: 'cmt_2' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    )
  })

  it('morphs into the conflict explanation and offers restore-instead', () => {
    const onRestoreInstead = vi.fn()
    revertMutate.mockImplementation((_vars, opts) => {
      opts.onError(new MergeConflictError([
        { entity_id: 'urn:a', path: [], reason: 'modified after the reverted commit' },
        { entity_id: 'urn:b', path: [], reason: 'modified after the reverted commit' },
      ]))
    })
    render(
      <RevertDialog
        open commit={COMMIT} wsId="ws1" graphId="g1"
        onClose={() => {}} onRestoreInstead={onRestoreInstead}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Undo change/ }))

    expect(screen.getByText(/can't be undone on its own/)).toBeInTheDocument()
    expect(screen.getByText('urn:a')).toBeInTheDocument()
    expect(screen.getByText(/2 items were/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Restore to just before it instead/ }))
    expect(onRestoreInstead).toHaveBeenCalledWith(
      expect.objectContaining({ commit_id: 'cmt_1' }),
    )
  })

  it('closes and toasts on success', () => {
    const onClose = vi.fn()
    revertMutate.mockImplementation((_vars, opts) => opts.onSuccess({ commitId: 'cmt_r' }))
    render(<RevertDialog open commit={COMMIT} wsId="ws1" graphId="g1" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Undo change/ }))
    expect(onClose).toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('success', expect.stringMatching(/undone/))
  })
})

describe('RestoreDialog', () => {
  it('renders the exact preview impact and fires the restore mutation', () => {
    previewState = {
      isLoading: false,
      data: {
        commitsUndone: 3,
        nodes: { create: 1, update: 12, delete: 4 },
        edges: { create: 0, update: 0, delete: 7 },
      },
    }
    render(<RestoreDialog open commit={COMMIT} wsId="ws1" graphId="g1" onClose={() => {}} />)

    expect(screen.getByText('Restore the graph to this point?')).toBeInTheDocument()
    expect(screen.getByText(/3 later revisions/)).toBeInTheDocument()
    expect(screen.getByText(/12 items updated/)).toBeInTheDocument()
    expect(screen.getByText(/Full history is kept/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Restore$/ }))
    expect(restoreMutate).toHaveBeenCalledWith(
      { commitId: 'cmt_2' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    )
  })

  it('shows the working state while the preview loads and disables the CTA', () => {
    previewState = { data: undefined, isLoading: true }
    render(<RestoreDialog open commit={COMMIT} wsId="ws1" graphId="g1" onClose={() => {}} />)
    expect(screen.getByText(/Working out the exact impact/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Restore$/ })).toBeDisabled()
  })

  it('says so when there is nothing to roll back', () => {
    previewState = {
      isLoading: false,
      data: { commitsUndone: 0, nodes: { create: 0, update: 0, delete: 0 }, edges: { create: 0, update: 0, delete: 0 } },
    }
    render(<RestoreDialog open commit={COMMIT} wsId="ws1" graphId="g1" onClose={() => {}} />)
    expect(screen.getByText(/already matches this point/)).toBeInTheDocument()
  })

  // ── keyboard: a dialog that is about to rewrite a graph must be operable and escapable ──

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(<RestoreDialog open commit={COMMIT} wsId="ws1" graphId="g1" onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('is announced as a modal dialog and labelled by its heading', () => {
    render(<RestoreDialog open commit={COMMIT} wsId="ws1" graphId="g1" onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-labelledby', 'restore-dialog-title')
    expect(document.getElementById('restore-dialog-title')).toHaveTextContent(/Restore the graph/)
  })

  it('moves focus into the dialog, not onto its destructive button', () => {
    render(<RestoreDialog open commit={COMMIT} wsId="ws1" graphId="g1" onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: /^Restore$/ }))
  })
})

