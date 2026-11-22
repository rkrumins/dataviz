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

  it('is amber for a change that can be taken back, red for one that destroys — and counts with separators', () => {
    const { unmount } = render(
      <DangerConfirmDialog isOpen title="Undo Set owner?" confirmPhrase="" confirmLabel="Undo" impactHeading="This will put back"
        sections={[{ label: 'entities', count: 31877, tone: 'warning', consequence: 'to what they held before' }]} irreversibleNote={null}
        onClose={() => {}} onConfirm={() => {}} />,
    )
    expect(screen.getByText('entities').closest('button')).toHaveTextContent('31,877entities')
    expect(screen.getByRole('heading', { name: 'This will put back' }).className).toMatch(/amber/)
    expect(screen.getByRole('button', { name: 'Undo' }).className).toMatch(/amber/)
    unmount()
    // A section that destroys keeps the red, though the action can be taken back.
    const removing = render(
      <DangerConfirmDialog isOpen title="Remove owner?" confirmPhrase="" confirmLabel="Apply" impactHeading="This will change"
        sections={[{ label: 'entities', count: 3, tone: 'destructive', consequence: 'lose owner' }]} irreversibleNote={null}
        onClose={() => {}} onConfirm={() => {}} />,
    )
    expect(screen.getByRole('heading', { name: 'This will change' }).className).toMatch(/red/)
    removing.unmount()
    // A deletion, as every delete dialog says it: red.
    render(<DangerConfirmDialog isOpen title="Delete Sales?" confirmPhrase="" sections={[{ label: 'Views', count: 2, consequence: 'deleted' }]}
      onClose={() => {}} onConfirm={() => {}} />)
    expect(screen.getByRole('heading', { name: 'This will destroy' }).className).toMatch(/red/)
    expect(screen.getByText('This cannot be undone')).toBeInTheDocument()
  })

  it('says an unknown impact in its own words, where there is nothing to try again', () => {
    const { unmount } = render(<DangerConfirmDialog isOpen title="Delete Sales?" confirmPhrase="" sections={[]} impactUnknown
      onClose={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText(/try again in a moment/)).toBeInTheDocument()
    unmount()
    render(<DangerConfirmDialog isOpen title="Remove owner?" confirmPhrase="" sections={[]} impactUnknown irreversibleNote={null}
      unknownMessage="It can’t be counted here." onClose={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText('It can’t be counted here.')).toBeInTheDocument()
    expect(screen.queryByText(/try again in a moment/)).toBeNull()
  })

  it('reads as a deletion when nothing else is said', async () => {
    const { finish } = renderDialog({ confirmLabel: 'Delete' })
    expect(document.querySelector('.lucide-trash2, .lucide-trash-2')).not.toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(screen.getByText('Deleting…')).toBeInTheDocument()
    await act(async () => { finish() })
  })
})
