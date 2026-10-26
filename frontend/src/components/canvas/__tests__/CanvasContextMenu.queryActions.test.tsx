/**
 * The right-click questions about a node sit together after its read
 * affordances (View, Trace, Focus, Copy URN), before the edits.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasContextMenu, type ContextMenuAction } from '../CanvasContextMenu'


describe('CanvasContextMenu — questions about a node', () => {
    it('lists them after Copy URN and before the edits, and runs the one picked', () => {
        const ask = vi.fn()
        const queryActions: ContextMenuAction[] = [
            { id: 'query-sources', label: 'What feeds this', icon: 'GitMerge', onClick: ask },
            { id: 'query-targets', label: 'What this feeds', icon: 'Workflow', onClick: vi.fn() },
        ]
        render(
            <CanvasContextMenu
                isOpen
                position={{ x: 10, y: 10 }}
                target={{ type: 'node', id: 'urn:x' }}
                onClose={vi.fn()}
                onCopyUrn={vi.fn()}
                onCreateChild={vi.fn()}
                queryActions={queryActions}
            />,
        )
        const labels = screen.getAllByRole('button').map((b) => b.textContent ?? '')
        const at = (text: string) => labels.findIndex((l) => l.includes(text))
        expect(at('Copy URN')).toBeLessThan(at('What feeds this'))
        expect(at('What this feeds')).toBeLessThan(at('Add Child Entity'))

        fireEvent.click(screen.getByText('What feeds this'))
        expect(ask).toHaveBeenCalled()
    })
})
