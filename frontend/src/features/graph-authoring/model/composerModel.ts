/**
 * composerModel — the pure tree model behind the Hierarchy Composer. A composer
 * tree is built and validated entirely in memory; on "Stage subtree" the panel
 * walks it pre-order, staging each node with its parent's just-returned temp urn
 * (grandparent → parent → child chaining). Keeping this pure makes the tree ops
 * and ordering unit-testable without React or the stores.
 */
import { generateId } from '@/lib/utils'
import type { EntityTypeSchema } from '@/types/schema'
import { validateEntityDraft, type EntityDraftValidation } from './ontologyGuard'

export interface ComposerNode {
  /** Stable in-memory key (not a graph urn — the staged urn is minted on save). */
  tempKey: string
  entityType: string
  name: string
  properties: Record<string, unknown>
  children: ComposerNode[]
}

export function makeComposerNode(entityType: string, name = ''): ComposerNode {
  return { tempKey: generateId('composer'), entityType, name, properties: {}, children: [] }
}

/** Append `child` under `parentKey` (or at the root level when null). Immutable. */
export function addChildAt(roots: ComposerNode[], parentKey: string | null, child: ComposerNode): ComposerNode[] {
  if (parentKey === null) return [...roots, child]
  return roots.map((n) => mapInto(n, parentKey, (p) => ({ ...p, children: [...p.children, child] })))
}

/** Patch the node with `key` (name/entityType/properties). Immutable. */
export function updateNodeAt(roots: ComposerNode[], key: string, patch: Partial<Omit<ComposerNode, 'tempKey' | 'children'>>): ComposerNode[] {
  return roots.map((n) => mapInto(n, key, (m) => ({ ...m, ...patch })))
}

/** Remove the node with `key` and its subtree. Immutable. */
export function removeNodeAt(roots: ComposerNode[], key: string): ComposerNode[] {
  return roots
    .filter((n) => n.tempKey !== key)
    .map((n) => ({ ...n, children: removeNodeAt(n.children, key) }))
}

export function findNodeByKey(roots: ComposerNode[], key: string): ComposerNode | undefined {
  for (const n of roots) {
    if (n.tempKey === key) return n
    const found = findNodeByKey(n.children, key)
    if (found) return found
  }
  return undefined
}

export interface ComposerSummary {
  total: number
  byType: Record<string, number>
}

export function summarizeByType(roots: ComposerNode[]): ComposerSummary {
  const byType: Record<string, number> = {}
  let total = 0
  const walk = (nodes: ComposerNode[]) => {
    for (const n of nodes) {
      total++
      byType[n.entityType] = (byType[n.entityType] ?? 0) + 1
      walk(n.children)
    }
  }
  walk(roots)
  return { total, byType }
}

export interface FlatComposerEntry {
  node: ComposerNode
  /** tempKey of the parent in the tree, or null for a root. */
  parentKey: string | null
  depth: number
}

/** Pre-order flatten — parents always precede their children (staging order). */
export function flattenPreOrder(roots: ComposerNode[]): FlatComposerEntry[] {
  const out: FlatComposerEntry[] = []
  const walk = (nodes: ComposerNode[], parentKey: string | null, depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, parentKey, depth })
      walk(n.children, n.tempKey, depth + 1)
    }
  }
  walk(roots, null, 0)
  return out
}

export interface ComposerValidation {
  ok: boolean
  errorsByKey: Record<string, EntityDraftValidation>
}

/** Per-node required-field validation across the whole tree. */
export function validateComposer(roots: ComposerNode[], entityTypes: EntityTypeSchema[]): ComposerValidation {
  const errorsByKey: Record<string, EntityDraftValidation> = {}
  let ok = true
  for (const entry of flattenPreOrder(roots)) {
    const v = validateEntityDraft(entry.node.entityType, entry.node.name, entry.node.properties, entityTypes)
    errorsByKey[entry.node.tempKey] = v
    if (!v.ok) ok = false
  }
  return { ok, errorsByKey }
}

/** Apply `fn` to the node matching `key` anywhere in the subtree rooted at `n`. */
function mapInto(n: ComposerNode, key: string, fn: (node: ComposerNode) => ComposerNode): ComposerNode {
  if (n.tempKey === key) return fn(n)
  return { ...n, children: n.children.map((c) => mapInto(c, key, fn)) }
}
