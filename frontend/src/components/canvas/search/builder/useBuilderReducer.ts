/**
 * State machine for the visual predicate builder.
 *
 * The tree root is always a GroupPredicate (so the builder can render
 * "+ Add condition" / "+ Add group" affordances even when empty). All
 * mutations work in terms of a `Path` — an array of child indices from
 * the root to the target node — which makes recursive operations
 * trivial to express.
 *
 * Hard caps from the backend service-layer validator are enforced here
 * client-side so the user gets inline feedback before submitting:
 *   - depth ≤ 6
 *   - leaves ≤ 64 across the tree
 *   - OR-branch ≤ 24 children
 *
 * The reducer is intentionally dumb. Higher-order behavior (running
 * the query, talking to the backend, debouncing the /explain hint)
 * lives in PredicateBuilder + useAdvancedSearch.
 */
import { useReducer, useCallback, useMemo } from 'react'

import type { Predicate, GroupPredicate } from '@/types/search'

import { LEAF_KINDS, type LeafKind } from './leafKinds'


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Index path from root to a tree node (inclusive of the root group
 *  itself when empty `[]`). Each segment is the child index in the
 *  containing group. */
export type Path = readonly number[]


/** Service-layer caps mirrored client-side. Single source of truth so
 *  changing one constant updates every cap-aware UI affordance. */
export const BUILDER_LIMITS = {
    maxDepth: 6,
    maxLeaves: 64,
    maxOrBranch: 24,
} as const


export interface ValidationIssue {
    /** Path into the tree where the issue applies. `[]` means the root. */
    path: Path
    message: string
    severity: 'error' | 'warn'
}


export interface BuilderState {
    /** The whole predicate tree, rooted at a GroupPredicate. */
    tree: GroupPredicate
    /** Computed each reduce; consumed by GroupRow/PredicateRow to render
     *  inline error chips. */
    issues: ValidationIssue[]
}


// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type BuilderAction =
    | { type: 'addLeaf'; path: Path; leafKind: LeafKind }
    | { type: 'addGroup'; path: Path; op: GroupPredicate['op'] }
    | { type: 'removeAt'; path: Path }
    | { type: 'updateLeaf'; path: Path; next: Predicate }
    | { type: 'toggleGroupOp'; path: Path; op: GroupPredicate['op'] }
    | { type: 'wrapInGroup'; path: Path; op: GroupPredicate['op'] }
    | { type: 'unwrapGroup'; path: Path }
    | { type: 'loadSeed'; predicate: Predicate }
    | { type: 'reset' }


// ---------------------------------------------------------------------------
// Helpers — pure tree operations
// ---------------------------------------------------------------------------

function emptyRoot(): GroupPredicate {
    return { kind: 'group', op: 'and', children: [] }
}


/** Get the node at `path`. Returns undefined if the path is invalid. */
export function nodeAt(tree: Predicate, path: Path): Predicate | undefined {
    let cur: Predicate | undefined = tree
    for (const i of path) {
        if (!cur || cur.kind !== 'group') return undefined
        cur = cur.children[i]
    }
    return cur
}


/** Replace the node at `path` with `replacer(current)`. Returns a new
 *  tree; original is untouched. If the path is empty, replaces the
 *  whole tree (caller must ensure the replacement is a GroupPredicate
 *  if it's intended as the new root). */
function mapAt(
    tree: GroupPredicate,
    path: Path,
    replacer: (current: Predicate) => Predicate | null,
): GroupPredicate {
    if (path.length === 0) {
        const next = replacer(tree)
        return (next && next.kind === 'group') ? next : emptyRoot()
    }
    const [head, ...rest] = path
    const child = tree.children[head]
    if (!child) return tree
    if (rest.length === 0) {
        const next = replacer(child)
        const nextChildren = [...tree.children]
        if (next === null) {
            nextChildren.splice(head, 1)
        } else {
            nextChildren[head] = next
        }
        return { ...tree, children: nextChildren }
    }
    if (child.kind !== 'group') return tree
    const updatedChild = mapAt(child, rest, replacer)
    const nextChildren = [...tree.children]
    nextChildren[head] = updatedChild
    return { ...tree, children: nextChildren }
}


/** Count total leaf predicates (non-group) anywhere in the tree. */
function countLeaves(p: Predicate): number {
    if (p.kind !== 'group') return 1
    let n = 0
    for (const c of p.children) n += countLeaves(c)
    return n
}


/** Maximum group nesting depth in the tree (root group = 1). */
function maxDepth(p: Predicate, current = 1): number {
    if (p.kind !== 'group') return current
    if (p.children.length === 0) return current
    let m = current
    for (const c of p.children) {
        m = Math.max(m, maxDepth(c, current + 1))
    }
    return m
}


/** Walk the tree producing inline validation issues. */
function validate(tree: GroupPredicate): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    const leaves = countLeaves(tree)
    if (leaves > BUILDER_LIMITS.maxLeaves) {
        issues.push({
            path: [],
            severity: 'error',
            message: `Too many conditions: ${leaves} / ${BUILDER_LIMITS.maxLeaves}.`,
        })
    }
    const depth = maxDepth(tree)
    if (depth > BUILDER_LIMITS.maxDepth) {
        issues.push({
            path: [],
            severity: 'error',
            message: `Groups nested too deep: ${depth} / ${BUILDER_LIMITS.maxDepth}.`,
        })
    }

    function walk(p: Predicate, path: Path) {
        if (p.kind !== 'group') return
        if (p.op === 'or' && p.children.length > BUILDER_LIMITS.maxOrBranch) {
            issues.push({
                path,
                severity: 'error',
                message: `Too many OR branches: ${p.children.length} / ${BUILDER_LIMITS.maxOrBranch}.`,
            })
        }
        if (p.op === 'not' && p.children.length !== 1) {
            issues.push({
                path,
                severity: 'error',
                message: 'NOT must contain exactly one condition.',
            })
        }
        // Leaf-level shape checks: catch obvious empty fields the user
        // hasn't filled yet so they aren't silently sent to the backend.
        for (let i = 0; i < p.children.length; i++) {
            const c = p.children[i]
            const childPath: Path = [...path, i]
            if (c.kind === 'property' && !c.key.trim()) {
                issues.push({
                    path: childPath,
                    severity: 'warn',
                    message: 'Pick a property key.',
                })
            }
            if (c.kind === 'hasProperty' && !c.key.trim()) {
                issues.push({
                    path: childPath,
                    severity: 'warn',
                    message: 'Pick a property key.',
                })
            }
            if (c.kind === 'tag' && c.values.length === 0) {
                issues.push({
                    path: childPath,
                    severity: 'warn',
                    message: 'Add at least one tag.',
                })
            }
            if (c.kind === 'entityType' && c.values.length === 0) {
                issues.push({
                    path: childPath,
                    severity: 'warn',
                    message: 'Pick at least one entity type.',
                })
            }
            if (c.kind === 'layer' && !c.layerAssignment.trim()) {
                issues.push({
                    path: childPath,
                    severity: 'warn',
                    message: 'Pick a layer.',
                })
            }
            if (c.kind === 'text' && !c.value.trim()) {
                issues.push({
                    path: childPath,
                    severity: 'warn',
                    message: 'Enter search text.',
                })
            }
            if (c.kind === 'withinHops' && c.urns.length === 0) {
                issues.push({
                    path: childPath,
                    severity: 'warn',
                    message: 'Add at least one anchor URN.',
                })
            }
            if (c.kind === 'descendantOf' && c.urns.length === 0) {
                issues.push({
                    path: childPath,
                    severity: 'warn',
                    message: 'Add at least one ancestor URN.',
                })
            }
            if (c.kind === 'path') {
                if (c.sourceUrns.length === 0) {
                    issues.push({
                        path: childPath,
                        severity: 'warn',
                        message: 'Add at least one source URN.',
                    })
                }
                if (c.targetUrns.length === 0) {
                    issues.push({
                        path: childPath,
                        severity: 'warn',
                        message: 'Add at least one target URN.',
                    })
                }
            }
            walk(c, childPath)
        }
    }
    walk(tree, [])
    return issues
}


function ensureRoot(p: Predicate): GroupPredicate {
    if (p.kind === 'group') return p
    // Seed was a leaf: wrap it in a top-level AND group so the builder
    // has somewhere to render "+ Add condition".
    return { kind: 'group', op: 'and', children: [p] }
}


function makeEmptyLeaf(kind: LeafKind): Predicate {
    const meta = LEAF_KINDS.find((m) => m.kind === kind)
    if (!meta) {
        // Defensive: typed callers can't hit this branch.
        throw new Error(`Unknown leaf kind: ${kind}`)
    }
    return meta.makeEmpty()
}


// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reduce(state: BuilderState, action: BuilderAction): BuilderState {
    switch (action.type) {
        case 'reset': {
            const tree = emptyRoot()
            return { tree, issues: validate(tree) }
        }
        case 'loadSeed': {
            const tree = ensureRoot(action.predicate)
            return { tree, issues: validate(tree) }
        }
        case 'addLeaf': {
            const newLeaf = makeEmptyLeaf(action.leafKind)
            const tree = mapAt(state.tree, action.path, (cur) => {
                if (cur.kind !== 'group') return cur
                return { ...cur, children: [...cur.children, newLeaf] }
            })
            return { tree, issues: validate(tree) }
        }
        case 'addGroup': {
            const newGroup: GroupPredicate = {
                kind: 'group',
                op: action.op,
                children: [],
            }
            const tree = mapAt(state.tree, action.path, (cur) => {
                if (cur.kind !== 'group') return cur
                return { ...cur, children: [...cur.children, newGroup] }
            })
            return { tree, issues: validate(tree) }
        }
        case 'removeAt': {
            if (action.path.length === 0) {
                // Removing the root means "reset".
                const tree = emptyRoot()
                return { tree, issues: validate(tree) }
            }
            const tree = mapAt(state.tree, action.path, () => null)
            return { tree, issues: validate(tree) }
        }
        case 'updateLeaf': {
            const tree = mapAt(state.tree, action.path, () => action.next)
            return { tree, issues: validate(tree) }
        }
        case 'toggleGroupOp': {
            const tree = mapAt(state.tree, action.path, (cur) => {
                if (cur.kind !== 'group') return cur
                return { ...cur, op: action.op }
            })
            return { tree, issues: validate(tree) }
        }
        case 'wrapInGroup': {
            const tree = mapAt(state.tree, action.path, (cur) => ({
                kind: 'group',
                op: action.op,
                children: [cur],
            }))
            return { tree, issues: validate(tree) }
        }
        case 'unwrapGroup': {
            const target = nodeAt(state.tree, action.path)
            if (!target || target.kind !== 'group' || target.children.length !== 1) {
                return state
            }
            const onlyChild = target.children[0]
            const tree = mapAt(state.tree, action.path, () => onlyChild)
            // Special case: if the root itself is unwrapped, ensure we
            // still have a group at the root.
            const safeTree = ensureRoot(tree)
            return { tree: safeTree, issues: validate(safeTree) }
        }
        default:
            return state
    }
}


// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseBuilderReducer {
    state: BuilderState
    /** True when there are any error-severity issues. */
    hasErrors: boolean
    addLeaf: (path: Path, leafKind: LeafKind) => void
    addGroup: (path: Path, op: GroupPredicate['op']) => void
    removeAt: (path: Path) => void
    updateLeaf: (path: Path, next: Predicate) => void
    toggleGroupOp: (path: Path, op: GroupPredicate['op']) => void
    wrapInGroup: (path: Path, op: GroupPredicate['op']) => void
    unwrapGroup: (path: Path) => void
    loadSeed: (predicate: Predicate) => void
    reset: () => void
}


export function useBuilderReducer(initial?: Predicate): UseBuilderReducer {
    const [state, dispatch] = useReducer(reduce, undefined, () => {
        const tree = initial ? ensureRoot(initial) : emptyRoot()
        return { tree, issues: validate(tree) }
    })

    const hasErrors = useMemo(
        () => state.issues.some((i) => i.severity === 'error'),
        [state.issues],
    )

    return {
        state,
        hasErrors,
        addLeaf: useCallback((path, leafKind) => dispatch({ type: 'addLeaf', path, leafKind }), []),
        addGroup: useCallback((path, op) => dispatch({ type: 'addGroup', path, op }), []),
        removeAt: useCallback((path) => dispatch({ type: 'removeAt', path }), []),
        updateLeaf: useCallback((path, next) => dispatch({ type: 'updateLeaf', path, next }), []),
        toggleGroupOp: useCallback((path, op) => dispatch({ type: 'toggleGroupOp', path, op }), []),
        wrapInGroup: useCallback((path, op) => dispatch({ type: 'wrapInGroup', path, op }), []),
        unwrapGroup: useCallback((path) => dispatch({ type: 'unwrapGroup', path }), []),
        loadSeed: useCallback((predicate) => dispatch({ type: 'loadSeed', predicate }), []),
        reset: useCallback(() => dispatch({ type: 'reset' }), []),
    }
}
