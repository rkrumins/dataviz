/**
 * The kinds of change a drop makes, and how each is said — see DropHint. Every gesture says which
 * kind it is: a DATA change (the graph itself), a VIEW change (only how this view arranges things),
 * or none at all, and why.
 */
import type { MoveVerdict } from './useReparentNode'

export type DropKind = 'data' | 'view' | 'blocked'

export interface DropHintSpec {
  kind: DropKind
  title: string
  detail?: string
}

/** What a move onto `name` would do, as a hint — none when the drop would do nothing. */
export function moveHint(v: MoveVerdict, name: string): DropHintSpec | null {
  switch (v.kind) {
    case 'none': return null
    case 'view': return { kind: 'view', title: `Back under ${name}`, detail: 'only this view' }
    case 'data': return { kind: 'data', title: `Move inside ${name}`, detail: 'changes the data' }
    default: return { kind: 'blocked', title: v.hint }
  }
}

export const sameHint = (a: DropHintSpec | null, b: DropHintSpec | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.title === b.title && a.detail === b.detail)

/** The ring a drop target wears while a drag of this kind hovers it. */
export function dropSurfaceClass(kind: DropKind): string {
  switch (kind) {
    case 'data':
      return 'ring-2 ring-accent-lineage bg-accent-lineage/[0.08] shadow-[0_0_0_4px_rgb(var(--nx-accent-lineage-rgb)_/_0.12)]'
    case 'view':
      return 'outline-dashed outline-2 -outline-offset-2 outline-ink-muted/60 bg-black/[0.02] dark:bg-white/[0.03]'
    default:
      return 'ring-1 ring-glass-border'
  }
}
