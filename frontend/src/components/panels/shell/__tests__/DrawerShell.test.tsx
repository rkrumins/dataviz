/**
 * DrawerShell — what every drawer gets from its frame: keys typed in it stay in it, Esc leaves a
 * field and then closes, ⌘/Ctrl+S stages, an unstaged edit is asked about before any move and
 * before the page is left, and focus follows what is shown without being stolen.
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore } from '@/store/canvas'
import { useCanvasKeyboard } from '@/hooks/useCanvasKeyboard'
import { DrawerFrame, DrawerShell, type DrawerShellProps } from '../DrawerShell'

beforeEach(() => {
  useCanvasStore.setState({
    drawerNodeId: 'a', drawerEdge: null, drawerEdgeEditRequest: false,
    drawerHistory: { entries: [{ kind: 'node', id: 'a' }], cursor: 0 },
    selectedNodeIds: [], selectedEdgeIds: [], drawerDirty: false, pendingDrawerMove: null,
  })
})

function Drawer({ title = 'Orders', ...props }: Partial<DrawerShellProps> & { title?: string }) {
  return (
    <DrawerFrame panel="test-drawer" label="Test details">
      <DrawerShell titleId="t" focusKey={title} onClose={vi.fn()} {...props}>
        <h2 id="t" tabIndex={-1}>{title}</h2>
        <input aria-label="Name" />
        <button type="button">Inside</button>
      </DrawerShell>
    </DrawerFrame>
  )
}

describe('DrawerShell — keys', () => {
  it('Esc leaves a text field first, then closes', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Drawer onClose={onClose} />)
    await user.click(screen.getByLabelText('Name'))
    await user.keyboard('{Escape}')
    expect(screen.getByLabelText('Name')).not.toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()
    screen.getByRole('button', { name: 'Inside' }).focus()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+S stages — only when there is something to stage', async () => {
    const user = userEvent.setup()
    const onStage = vi.fn()
    const { rerender } = render(<Drawer onStage={onStage} canStage={false} />)
    await user.click(screen.getByLabelText('Name'))
    await user.keyboard('{Control>}s{/Control}')
    expect(onStage).not.toHaveBeenCalled()
    rerender(<Drawer onStage={onStage} canStage />)
    await user.keyboard('{Control>}s{/Control}')
    expect(onStage).toHaveBeenCalledTimes(1)
  })

  it('Backspace typed in the drawer never reaches the canvas shortcuts', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    function Canvas() {
      useCanvasKeyboard({ enabled: true, handlers: { onDelete } })
      return <Drawer />
    }
    render(<Canvas />)
    screen.getByRole('button', { name: 'Inside' }).focus()
    await user.keyboard('{Backspace}')
    await user.click(screen.getByLabelText('Name'))
    await user.keyboard('ab{Backspace}')
    expect(onDelete).not.toHaveBeenCalled()
  })
})

describe('DrawerShell — unsaved edits', () => {
  function EditingDrawer({ onStage = vi.fn(), onDiscard = vi.fn() }: { onStage?: () => void; onDiscard?: () => void }) {
    const [dirty, setDirty] = useState(true)
    return (
      <Drawer
        dirty={dirty}
        dirtyWhat="your changes to Orders"
        onStage={() => { onStage(); setDirty(false) }}
        canStage={dirty}
        onDiscard={() => { onDiscard(); setDirty(false) }}
      />
    )
  }

  it('a move is held and asked about; Keep editing changes nothing', async () => {
    const user = userEvent.setup()
    render(<EditingDrawer />)
    act(() => { useCanvasStore.getState().selectNode('b') })
    const dialog = screen.getByRole('alertdialog', { name: 'Unsaved changes' })
    expect(dialog).toHaveTextContent('your changes to Orders')
    expect(useCanvasStore.getState().drawerNodeId).toBe('a')
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(useCanvasStore.getState().drawerNodeId).toBe('a')
  })

  it('Esc in the dialog means keep editing — never discard', async () => {
    const user = userEvent.setup()
    const onDiscard = vi.fn()
    render(<EditingDrawer onDiscard={onDiscard} />)
    act(() => { useCanvasStore.getState().openNodeDrawer('b') })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onDiscard).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().drawerNodeId).toBe('a')
  })

  it('Discard throws the edit away and carries the move out — selection and all', async () => {
    const user = userEvent.setup()
    const onDiscard = vi.fn()
    render(<EditingDrawer onDiscard={onDiscard} />)
    act(() => { useCanvasStore.getState().selectNode('b') })
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(useCanvasStore.getState().drawerNodeId).toBe('b')
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['b'])
  })

  it('Stage and continue keeps the edit for Review, then moves', async () => {
    const user = userEvent.setup()
    const onStage = vi.fn()
    render(<EditingDrawer onStage={onStage} />)
    act(() => { useCanvasStore.getState().closeNodeDrawer() })
    await user.click(screen.getByRole('button', { name: 'Stage and continue' }))
    expect(onStage).toHaveBeenCalledTimes(1)
    expect(useCanvasStore.getState().drawerNodeId).toBeNull()
  })

  it('the focus is trapped in the dialog', async () => {
    const user = userEvent.setup()
    render(<EditingDrawer />)
    act(() => { useCanvasStore.getState().openNodeDrawer('b') })
    const dialog = screen.getByRole('alertdialog')
    for (let i = 0; i < 5; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('leaving the page asks the browser to confirm, only while dirty', () => {
    const { rerender } = render(<Drawer dirty />)
    const ask = () => {
      const e = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(ask()).toBe(true)
    rerender(<Drawer dirty={false} />)
    expect(ask()).toBe(false)
  })

  it('the store knows while the drawer is dirty, and forgets when it goes', () => {
    const { unmount } = render(<Drawer dirty />)
    expect(useCanvasStore.getState().drawerDirty).toBe(true)
    unmount()
    expect(useCanvasStore.getState().drawerDirty).toBe(false)
  })
})

describe('DrawerShell — focus', () => {
  it('follows what is shown when the reader is in the drawer, and is not stolen otherwise', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const { rerender } = render(<Drawer title="Orders" />)
    // Opened while working elsewhere: focus stays there.
    outside.focus()
    rerender(<Drawer title="Revenue" />)
    expect(outside).toHaveFocus()
    // Working in the drawer: a new entity puts focus on its title.
    screen.getByRole('button', { name: 'Inside' }).focus()
    rerender(<Drawer title="Customers" />)
    expect(screen.getByRole('heading', { name: 'Customers' })).toHaveFocus()
    outside.remove()
  })

  it('closing gives focus back to where it came from', async () => {
    const user = userEvent.setup()
    const origin = document.createElement('button')
    document.body.appendChild(origin)
    origin.focus()
    const { unmount } = render(<Drawer />)
    await user.tab()
    await user.click(screen.getByRole('button', { name: 'Inside' }))
    unmount()
    expect(origin).toHaveFocus()
    origin.remove()
  })
})
