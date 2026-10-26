/**
 * What every line of a sentence needs from the builder — how to change the
 * query, the editors' data, which token is open — handed down once instead
 * of through every line's props, so a memoised line re-renders only when
 * its own clause or its own count changes.
 */
import { createContext, useContext } from 'react'

import type { NodeRef, Predicate } from '@/types/search'

import type { ConditionEditorProps } from '../ConditionRow'
import type { CodeKind } from '../vocabulary/filterKinds'

import type { Path, SentenceLine } from './clauseModel'


export interface SentenceActions {
    /** A value changed: no undo step. ``structural``: a change of shape. */
    replace: (path: Path, next: Predicate, structural?: boolean) => void
    remove: (path: Path) => void
    add: (into: Path, p: Predicate) => void
    duplicate: (path: Path) => void
    wrap: (path: Path, op: 'or' | 'not') => void
    setSubject: (types: string[]) => void
    setRelativeTypes: (line: Extract<SentenceLine, { kind: 'relation' }>, types: string[]) => void
    setRelativeRefs: (line: Extract<SentenceLine, { kind: 'relation' }>, refs: NodeRef[]) => void
    /** Join the listed clauses by "and" (all of them) or "or" (any). */
    setCombine: (op: 'and' | 'or') => void
    editInCode: () => void
    onOpenCode?: (kind: CodeKind) => void
    setOpenToken: (key: string | null) => void
}

export interface SentenceContextValue extends SentenceActions {
    /** What Form's editors are given, less the clause itself. */
    editorProps: Omit<ConditionEditorProps, 'value' | 'onChange'>
    /** The types this view holds, most common first. */
    presentTypes: string[]
    isRunning: boolean
    /** How the listed clauses combine. */
    combine: 'and' | 'or'
}

export const SentenceContext = createContext<SentenceContextValue | null>(null)

export function useSentence(): SentenceContextValue {
    const ctx = useContext(SentenceContext)
    if (!ctx) throw new Error('A sentence line renders inside SentenceBuilder')
    return ctx
}
