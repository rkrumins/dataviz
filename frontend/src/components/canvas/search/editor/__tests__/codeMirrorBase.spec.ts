/**
 * The editors' colours. The channel variables hold space-separated triples
 * (``99 102 241``), so an alpha goes after a slash: ``rgba(var(--x), 0.22)``
 * is invalid CSS and paints nothing — which left every selection in Code
 * mode invisible, the selected completion unmarked and the active line
 * plain.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'

import { baseExtensions } from '../codeMirrorBase'


describe('codeMirrorBase — colours', () => {
    it('writes each alpha on a channel variable after a slash, the selection included', () => {
        const view = new EditorView({
            parent: document.body,
            state: EditorState.create({ doc: 'type:dataset', extensions: baseExtensions({ ariaLabel: 'Query' }) }),
        })
        const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n')
        const drawn = view.dom.querySelector('.cm-selectionLayer')
        view.destroy()
        expect(css).not.toMatch(/rgba?\(var\(--[\w-]+\)\s*,/)
        // Drawn behind the text, in the selector CodeMirror's own theme
        // uses for a focused selection — so this colour wins over its grey.
        expect(css).toMatch(
            /\.cm-focused > \.cm-scroller > \.cm-selectionLayer \.cm-selectionBackground[^{]*\{[^}]*rgb\(var\(--nx-accent-lineage-rgb\) \/ 0\.22\)/)
        expect(drawn).not.toBeNull()
    })
})
