/**
 * CypherEditor — Cypher in a CodeMirror editor, coloured
 * (``cypherLanguage``). Read-only to show a compiled query, editable to
 * write one; ⌘↵ runs; an error the database reported is underlined where
 * it points.
 */
import { setDiagnostics } from '@codemirror/lint'
import { Annotation, Compartment, EditorState, Prec, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useMemo, useRef } from 'react'

import { cn } from '@/lib/utils'

import { baseExtensions, roleHighlighting } from './codeMirrorBase'
import { cypherRanges } from './cypherLanguage'


export interface CypherEditorProps {
    value: string
    readOnly?: boolean
    onChange?: (text: string) => void
    /** ⌘↵. */
    onRun?: () => void
    /** An error to underline: from, to, and what it says. */
    error?: { from: number; to: number; message: string } | null
    ariaLabel: string
    placeholder?: string
    className?: string
}

const FromOutside = Annotation.define<boolean>()


export function CypherEditor(props: CypherEditorProps) {
    const host = useRef<HTMLDivElement>(null)
    const view = useRef<EditorView | null>(null)
    const latest = useRef(props)
    useEffect(() => { latest.current = props })
    const readOnly = useMemo(() => new Compartment(), [])

    useEffect(() => {
        const current = latest.current
        const editor = new EditorView({
            parent: host.current!,
            state: EditorState.create({
                doc: current.value,
                extensions: [
                    Prec.highest(keymap.of([
                        { key: 'Mod-Enter', run: () => { latest.current.onRun?.(); return Boolean(latest.current.onRun) } },
                    ])),
                    ...baseExtensions({ ariaLabel: current.ariaLabel, placeholder: current.placeholder }),
                    roleHighlighting(cypherRanges),
                    readOnly.of(EditorState.readOnly.of(Boolean(current.readOnly))),
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged && !update.transactions.some((t) => t.annotation(FromOutside))) {
                            latest.current.onChange?.(update.state.doc.toString())
                        }
                    }),
                ],
            }),
        })
        view.current = editor
        return () => {
            editor.destroy()
            view.current = null
        }
    }, [readOnly])

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
        view.current?.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(Boolean(props.readOnly))) })
    }, [props.readOnly, readOnly])

    useEffect(() => {
        const editor = view.current
        if (!editor) return
        const length = editor.state.doc.length
        const error = props.error
        editor.dispatch(setDiagnostics(editor.state, error ? [{
            from: Math.min(error.from, length),
            to: Math.min(Math.max(error.to, error.from + 1), length),
            severity: 'error',
            message: error.message,
        }] : []))
    }, [props.error])

    return <div ref={host} className={cn('min-h-[3rem]', props.className)} />
}
