/**
 * ConflictResolver — RTL tests pinning the two reported failures:
 *   • the modal no longer self-closes: a pointer interaction inside it must NOT reach a
 *     document-level "click outside → close" listener (the BranchSwitcher dropdown bug);
 *   • it scales: bulk "take all" resolves every field at once, and the entity list is
 *     virtualized so 1000s of conflicts don't mount 1000s of cards.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConflictResolver } from '../components/ConflictResolver'

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
      fireEvent.mouseDown(screen.getByText(/Resolve 2 conflicting entities/i))
      expect(outside).not.toHaveBeenCalled() // the fix — mousedown is stopped at the modal root
      expect(onCancel).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('mousedown', outside)
    }
  })

  it('merges with the default pick (this PR) for every conflicted entity', () => {
    const onResolve = vi.fn()
    render(<ConflictResolver conflicts={conflicts} seeds={seeds} onCancel={vi.fn()} onResolve={onResolve} />)
    fireEvent.click(screen.getByText('Merge with resolutions'))
    expect(onResolve).toHaveBeenCalledWith({
      'urn:a': { displayName: 'A1' },
      'urn:b': { description: 'B1' },
    })
  })

  it('"take all → Current target" sets every field to the target value before merging', () => {
    const onResolve = vi.fn()
    render(<ConflictResolver conflicts={conflicts} seeds={seeds} onCancel={vi.fn()} onResolve={onResolve} />)
    // exact name matches only the toolbar bulk button (per-field buttons read "Current target <value>")
    fireEvent.click(screen.getByRole('button', { name: 'Current target' }))
    fireEvent.click(screen.getByText('Merge with resolutions'))
    expect(onResolve).toHaveBeenCalledWith({
      'urn:a': { displayName: 'A2' },
      'urn:b': { description: 'B2' },
    })
  })

  it('virtualizes the list: 500 conflicts accept the load but mount far fewer cards', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      entity_id: `urn:e${i}`, path: ['displayName'], base: `b${i}`, ours: `o${i}`, theirs: `t${i}`,
    }))
    render(<ConflictResolver conflicts={many} seeds={{}} onCancel={vi.fn()} onResolve={vi.fn()} />)
    expect(screen.getByText(/Resolve 500 conflicting entities/i)).toBeInTheDocument()
    expect(screen.queryAllByText('Delete instead').length).toBeLessThan(500)
  })
})
