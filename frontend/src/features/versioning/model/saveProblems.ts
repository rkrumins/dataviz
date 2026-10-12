/**
 * Why a save was refused, in terms the user can act on. The server refuses a save as a whole (an
 * ontology or integrity violation — nothing is written) and names each offending entity; this maps
 * those violations back onto the STAGED CHANGES that caused them, so Review & Save can say what
 * failed, why, and offer the fix (discard that change) right where it is.
 */
import type { StagedChange } from '@/store/stagedChangesStore'

export interface SaveProblem {
  /** What the entity is called (from the server, else the change's own label). */
  name: string
  /** The server's plain-language reason. */
  reason: string
  /** The staged changes that produced it (empty when none can be matched — still shown). */
  changeIds: string[]
}

interface Violation { entity_id?: string; name?: string; reason?: string }

const bare = (id: string) => (id.startsWith('gv:') ? id.slice(3) : id)

/** Every id a staged change is known by (its target, its urn, a moved entity). */
function keysOf(c: StagedChange): string[] {
  const after = (c.after ?? {}) as Record<string, unknown>
  return [c.targetId, c.targetUrn, typeof after.childId === 'string' ? after.childId : undefined]
    .filter((k): k is string => !!k)
    .map(bare)
}

export function mapSaveProblems(violations: readonly Violation[], changes: readonly StagedChange[]): SaveProblem[] {
  const byKey = new Map<string, StagedChange[]>()
  for (const c of changes) {
    for (const k of keysOf(c)) byKey.set(k, [...(byKey.get(k) ?? []), c])
  }
  const problems = new Map<string, SaveProblem>()
  for (const v of violations) {
    const reason = v.reason || 'This change breaks a rule of the ontology.'
    const matched = v.entity_id ? byKey.get(bare(v.entity_id)) ?? [] : []
    // The name the user knows it by: for a rename that is the name BEFORE it (the server only has
    // the payload's new one).
    const known = (matched[0]?.before as { label?: unknown } | undefined)?.label
    const name = (typeof known === 'string' && known) || v.name || (matched[0]?.summary ?? v.entity_id ?? 'An entity')
    const key = `${reason}::${v.entity_id ?? ''}`
    const prior = problems.get(key)
    problems.set(key, {
      name,
      reason,
      changeIds: [...new Set([...(prior?.changeIds ?? []), ...matched.map((c) => c.id)])],
    })
  }
  return [...problems.values()]
}
