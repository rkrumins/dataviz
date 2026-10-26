/**
 * DslEditor — the query language in a CodeMirror editor: coloured by what
 * the parser reads, the parser's error underlined where it points, and
 * completion from the view's own vocabulary (``dslLanguage``).
 *
 * Controlled by ``value``: typing reports ``onChange``; a new ``value``
 * from outside (the visual builder, undo, a canvas question) replaces the
 * text without entering the editor's own undo history. ⌘↵ applies, Esc
 * goes back to the query as it was — unless the completion list is open,
 * which Esc closes first.
 *
 * Selecting works as in any code editor, plus whole conditions: a
 * double-click on the word that starts one (``tag`` of ``tag:PII``,
 * ``outgoing``, ``NOT``) selects all of it, and ⌘I widens the selection
 * to the condition around it, then its group, then the whole query.
 */
import { completionStatus } from '@codemirror/autocomplete'
import { Annotation, Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'

import { cn } from '@/lib/utils'

import { baseExtensions, roleHighlighting } from '../../editor/codeMirrorBase'

import {
    conditionAtHead, type DslVocabulary, dslCompletionSource, dslLint, dslRanges, widerCondition,
} from './dslLanguage'


export interface DslEditorProps {
    value: string
    onChange: (text: string) => void
    /** ⌘↵. */
    onApply: () => void
    /** Esc. */
    onRevert: () => void
    onBlur?: () => void
    vocabulary: DslVocabulary
    disabled?: boolean
    placeholder?: string
    ariaLabel?: string
    /** The element describing the editor's state — its error, say. */
    ariaDescribedBy?: string
    className?: string
}

export interface DslEditorHandle {
    /** Put ``text`` where the cursor is (over the selection), and focus —
     *  the cursor ``caret`` characters into it, or after it. */
    insert: (text: string, caret?: number) => void
}

/** Marks a change that came from ``value``, not from typing. */
const FromOutside = Annotation.define<boolean>()


export const DslEditor = forwardRef<DslEditorHandle, DslEditorProps>(function DslEditor(props, ref) {
    const host = useRef<HTMLDivElement>(null)
    const view = useRef<EditorView | null>(null)
    // Handlers and vocabulary change every render; the editor reads the
    // latest through this, so it is built once.
    const latest = useRef(props)
    latest.current = props
    const editable = useMemo(() => new Compartment(), [])
    const described = useMemo(() => new Compartment(), [])

    useEffect(() => {
        const current = latest.current
        const editor = new EditorView({
            parent: host.current!,
            state: EditorState.create({
                doc: current.value,
                extensions: [
                    Prec.highest(keymap.of([
                        { key: 'Mod-Enter', run: () => { latest.current.onApply(); return true } },
                        {
                            key: 'Escape',
                            run: (v) => {
                                if (completionStatus(v.state)) return false
                                latest.current.onRevert()
                                return true
                            },
                        },
                        {
                            key: 'Mod-i',
                            preventDefault: true,
                            run: (v) => {
                                const { from, to } = v.state.selection.main
                                const span = widerCondition(v.state.doc.toString(), from, to)
                                    ?? { from: 0, to: v.state.doc.length }
                                v.dispatch({ selection: EditorSelection.single(span.from, span.to), userEvent: 'select' })
                                return true
                            },
                        },
                    ])),
                    // A double-click on the word that starts a condition
                    // selects the whole condition; elsewhere, the word.
                    EditorView.mouseSelectionStyle.of((v, event) => {
                        if (event.detail !== 2 || event.button !== 0
                            || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null
                        const pos = v.posAtCoords({ x: event.clientX, y: event.clientY })
                        const span = pos == null ? null : conditionAtHead(v.state.doc.toString(), pos)
                        if (!span) return null
                        const selection = EditorSelection.single(span.from, span.to)
                        return { get: () => selection, update: () => false }
                    }),
                    ...baseExtensions({
                        ariaLabel: current.ariaLabel ?? 'Query',
                        placeholder: current.placeholder,
                        complete: [dslCompletionSource(() => latest.current.vocabulary)],
                    }),
                    roleHighlighting(dslRanges),
                    dslLint(() => latest.current.vocabulary),
                    editable.of(EditorView.editable.of(!current.disabled)),
                    described.of(current.ariaDescribedBy
                        ? EditorView.contentAttributes.of({ 'aria-describedby': current.ariaDescribedBy })
                        : []),
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged && !update.transactions.some((t) => t.annotation(FromOutside))) {
                            latest.current.onChange(update.state.doc.toString())
                        }
                    }),
                    EditorView.domEventHandlers({
                        blur: () => { latest.current.onBlur?.(); return false },
                    }),
                ],
            }),
        })
        view.current = editor
        return () => {
            editor.destroy()
            view.current = null
        }
    }, [editable, described])

    // A new value from outside replaces the text — never an echo of typing.
    useEffect(() => {
        const editor = view.current
        if (!editor) return
        const doc = editor.state.doc.toString()
        if (doc === props.value) return
        editor.dispatch({
            changes: { from: 0, to: doc.length, insert: props.value },
            annotations: [FromOutside.of(true), Transaction.addToHistory.of(false)],
        })
    }, [props.value])

    useEffect(() => {
        view.current?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!props.disabled)) })
    }, [props.disabled, editable])

    useEffect(() => {
        view.current?.dispatch({
            effects: described.reconfigure(props.ariaDescribedBy
                ? EditorView.contentAttributes.of({ 'aria-describedby': props.ariaDescribedBy })
                : []),
        })
    }, [props.ariaDescribedBy, described])

    useImperativeHandle(ref, () => ({
        insert: (text: string, caret?: number) => {
            const editor = view.current
            if (!editor) return
            const { from, to } = editor.state.selection.main
            editor.dispatch({
                changes: { from, to, insert: text },
                selection: { anchor: from + (caret ?? text.length) },
                userEvent: 'input',
            })
            editor.focus()
        },
    }), [])

    return <div ref={host} className={cn('min-h-[4.5rem]', props.className)} />
})
