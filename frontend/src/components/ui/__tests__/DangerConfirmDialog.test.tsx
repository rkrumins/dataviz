/**
 * DangerConfirmDialog for an action that isn't a deletion — an undo, applying a bulk change: it
 * shows the action's own icon and, while it runs, the action's own words, never "Deleting…".
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Undo2 } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { DangerConfirmDialog } from '../DangerConfirmDialog'

function renderDialog(props: Partial<Parameters<typeof DangerConfirmDialog>[0]> = {}) {
  let finish: () => void = () => {}
  const onConfirm = () => new Promise<void>((resolve) => { finish = resolve })
  render(
    <DangerConfirmDialog isOpen title="Undo Fill owner?" confirmPhrase="" confirmLabel="Undo"
      sections={[{ label: 'Entities', count: 3, tone: 'warning', consequence: 'put back' }]} irreversibleNote={null}
      onClose={() => {}} onConfirm={onConfirm} {...props} />,
  )
  return { finish: () => finish() }
}

describe('DangerConfirmDialog — an action that isn’t a deletion', () => {
  it('shows its own icon and its own words while it runs', async () => {
    const { finish } = renderDialog({ icon: Undo2, busyLabel: 'Starting the undo…' })
    expect(document.querySelector('.lucide-trash2, .lucide-trash-2')).toBeNull()
    expect(document.querySelector('.lucide-undo2, .lucide-undo-2')).not.toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) })
    expect(screen.getByText('Starting the undo…')).toBeInTheDocument()
    expect(screen.queryByText('Deleting…')).toBeNull()
    await act(async () => { finish() })
  })

  it('reads as a deletion when nothing else is said', async () => {
    const { finish } = renderDialog({ confirmLabel: 'Delete' })
    expect(document.querySelector('.lucide-trash2, .lucide-trash-2')).not.toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(screen.getByText('Deleting…')).toBeInTheDocument()
    await act(async () => { finish() })
  })
})
