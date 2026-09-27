/**
 * propertyOps — how the Property Manager speaks of property operations written into a draft:
 * what an operation's search narrows to on the server, how an operation and what it did read,
 * and which keys the draft's operations changed (the Properties tab's badges).
 */
import type {
  PropertyOpJob, PropertyOpKind, PropertyOpList, PropertyOpRequest,
} from '@/services/versioningApiService'
import type { Predicate } from '@/types/search'

/** Whether an operation is still under way. */
export function isLive(op: PropertyOpJob): boolean {
  return op.status === 'pending' || op.status === 'running'
}

/** The part of a search an operation can change, as the server narrows it — `fillEmpty` to the
 *  entities whose key is empty, `rename` and `remove` to those that have it. `null` for a `set`,
 *  which can change any match. */
export function withPrecondition(
  op: Pick<PropertyOpRequest, 'kind' | 'key'>, predicate: Predicate,
): Predicate | null {
  const need = op.kind === 'fillEmpty'
    ? { kind: 'property', key: op.key, op: 'isEmpty' }
    : op.kind === 'rename' || op.kind === 'remove'
      ? { kind: 'hasProperty', key: op.key, negate: false }
      : null
  return need ? ({ kind: 'group', op: 'and', children: [predicate, need] } as Predicate) : null
}

function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length <= 80 ? text : `${text.slice(0, 79)}…`
}

/** An operation as its commits name it: "Set owner = alice". */
export function opLabel(op: PropertyOpJob['op']): string {
  switch (op.kind) {
    case 'set': return `Set ${op.key} = ${shown(op.value)}`
    case 'fillEmpty': return `Fill empty ${op.key} with ${shown(op.value)}`
    case 'rename': return `Rename ${op.key} to ${op.newKey}`
    case 'remove': return `Remove ${op.key}`
  }
}

const count = (n: number | undefined, one: string, many: string = `${one}s`) =>
  `${(n ?? 0).toLocaleString()} ${n === 1 ? one : many}`

/** What a finished job did, in a line: the parts worth saying, largest first. */
export function opOutcome(job: PropertyOpJob): string {
  const s = job.summary ?? {}
  const parts = job.kind === 'undo'
    ? [
      count(s.restored, 'entity put back', 'entities put back'),
      s.changedSince ? `${count(s.changedSince, 'edited since', 'edited since')}, left as it is` : null,
      s.missing ? `${count(s.missing, 'no longer in the draft', 'no longer in the draft')}` : null,
    ]
    : [
      count(s.applied, 'entity changed', 'entities changed'),
      s.unchanged ? `${count(s.unchanged, 'already so', 'already so')}` : null,
      s.notInDraft ? `${count(s.notInDraft, 'not in this draft', 'not in this draft')}` : null,
      s.skipped?.targetExists
        ? `${count(s.skipped.targetExists, 'skipped', 'skipped')}: the new name has a value` : null,
      s.skipped?.ontology
        ? `${count(s.skipped.ontology, 'skipped', 'skipped')}: the ontology refused it` : null,
    ]
  return parts.filter(Boolean).join(' · ')
}

/** An operation that wrote something and wasn't undone since — what the draft now holds. */
function standing(op: PropertyOpJob, list: PropertyOpJob[]): boolean {
  if (op.kind !== 'apply' || !(op.summary?.commits?.length)) return false
  const undo = op.undoneBy ? list.find((o) => o.jobId === op.undoneBy) : undefined
  return !undo || undo.status === 'failed' || undo.status === 'cancelled'
}

/** Whether an operation can be undone now: it wrote something, isn't undone, and nothing else is
 *  being written into the draft. */
export function canUndo(op: PropertyOpJob, list: PropertyOpList): boolean {
  return standing(op, list.ops) && !list.ops.some(isLive)
}

export interface OpsOverlayEntry {
  kinds: Set<PropertyOpKind>
  /** The new name a rename gave the key. */
  renameTo?: string
  /** The value the latest set or fill wrote. */
  value?: unknown
}

/** Each key the draft's standing operations changed, and how — the Properties tab's badges. */
export function opsOverlay(list?: PropertyOpList): Map<string, OpsOverlayEntry> {
  const map = new Map<string, OpsOverlayEntry>()
  for (const op of [...(list?.ops ?? [])].reverse()) {            // oldest first: the latest wins
    if (!standing(op, list!.ops)) continue
    const entry = map.get(op.op.key) ?? { kinds: new Set<PropertyOpKind>() }
    entry.kinds.add(op.op.kind)
    if (op.op.kind === 'rename') entry.renameTo = op.op.newKey
    if (op.op.kind === 'set' || op.op.kind === 'fillEmpty') entry.value = op.op.value
    map.set(op.op.key, entry)
  }
  return map
}
