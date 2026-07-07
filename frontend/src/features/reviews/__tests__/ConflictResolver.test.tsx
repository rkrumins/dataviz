/**
 * ConflictResolver — RTL tests pinning the reported failures + the redesigned flow:
 *   • the modal no longer self-closes (a pointer interaction inside it must NOT reach a
 *     document-level "click outside → close" listener — the BranchSwitcher dropdown bug);
 *   • field conflicts merge by side (default = your version; bulk "take all incoming");
 *   • a delete/modify conflict (you edited an entity main deleted) resolves to a real delete
 *     (null), NEVER {} — the empty-payload crash;
 *   • it scales: the entity list is virtualized.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ConflictResolver } from '../components/ConflictResolver'

// jsdom has no layout, so @tanstack/react-virtual would render 0 rows. Give it a viewport + a
// ResizeObserver so the virtualized entity cards actually mount and can be interacted with.
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

const conflicts = [
  { entity_id: 'urn:a', path: ['displayName'], base: 'A0', ours: 'A1', theirs: 'A2' },
  { entity_id: 'urn:b', path: ['description'], base: 'B0', ours: 'B1', theirs: 'B2' },
]
const seeds = {
  'urn:a': { displayName: 'A1' } as Record<string, unknown>,
  'urn:b': { description: 'B1' } as Record<string, unknown>,
}

describe('ConflictResolver', () => {
  it('does not let an interaction inside the modal reach a document outside-click listener', () => {
    const outside = vi.fn() // mimics BranchSwitcher's `document.addEventListener('mousedown', …)`
    const onCancel = vi.fn()
    document.addEventListener('mousedown', outside)
    try {
      render(<ConflictResolver conflicts={conflicts} seeds={seeds} onCancel={onCancel} onResolve={vi.fn()} />)
      fireEvent.mouseDown(screen.getByText(/Review changes from main/i))
      expect(outside).not.toHaveBeenCalled() // the fix — mousedown is stopped at the modal root
      expect(onCancel).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('mousedown', outside)
    }
  })

  it('merges with the default pick (your version) for every conflicted entity', () => {
    const onResolve = vi.fn()
    render(<ConflictResolver conflicts={conflicts} seeds={seeds} onCancel={vi.fn()} onResolve={onResolve} />)
    fireEvent.click(screen.getByText('Merge with resolutions'))
    expect(onResolve).toHaveBeenCalledWith({
      'urn:a': { displayName: 'A1' },
      'urn:b': { description: 'B1' },
    })
  })

  it('"Take all incoming" sets every field to the incoming value before merging', () => {
    const onResolve = vi.fn()
    render(<ConflictResolver conflicts={conflicts} seeds={seeds} onCancel={vi.fn()} onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('button', { name: 'Take all incoming' }))
    fireEvent.click(screen.getByText('Merge with resolutions'))
    expect(onResolve).toHaveBeenCalledWith({
      'urn:a': { displayName: 'A2' },
      'urn:b': { description: 'B2' },
    })
  })

  it('accepting an upstream deletion resolves to null (never {}) — the reported crash', () => {
    const onResolve = vi.fn()
    const dm = [{
      entity_id: 'urn:d', path: [], kind: 'delete/modify',
      base: { urn: 'urn:d', entityType: 'dataset', displayName: 'orig' },
      ours: { urn: 'urn:d', entityType: 'dataset', displayName: 'my edit' },
      theirs: null,
    }]
    render(<ConflictResolver conflicts={dm} seeds={{ 'urn:d': dm[0].ours as Record<string, unknown> }}
      onCancel={vi.fn()} onResolve={onResolve} />)
    fireEvent.click(screen.getByRole('button', { name: /accept deletion/i }))
    fireEvent.click(screen.getByText('Merge with resolutions'))
    expect(onResolve).toHaveBeenCalledWith({ 'urn:d': null })
  })

  it('virtualizes the list: 500 conflicts accept the load but mount far fewer cards', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      entity_id: `urn:e${i}`, path: ['displayName'], base: `b${i}`, ours: `o${i}`, theirs: `t${i}`,
    }))
    render(<ConflictResolver conflicts={many} seeds={{}} onCancel={vi.fn()} onResolve={vi.fn()} />)
    expect(screen.getByText(/Review changes from main/i)).toBeInTheDocument()
    expect(screen.queryAllByText('Delete instead').length).toBeLessThan(500)
  })
})
