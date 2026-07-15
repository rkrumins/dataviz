/**
 * Friendly label + tint per commit "kind", so each revision's type is legible at a glance.
 * Shared by the history timeline and the data-source recent-history list.
 */
const KIND_META: Record<string, { label: string; cls: string }> = {
  squash_publish: { label: 'published', cls: 'bg-violet-500/10 text-violet-500' },
  revert: { label: 'revert', cls: 'bg-rose-500/10 text-rose-500' },
  restore: { label: 'restore', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  import: { label: 'import', cls: 'bg-sky-500/10 text-sky-500' },
  sync: { label: 'sync', cls: 'bg-sky-500/10 text-sky-500' },
  // A pull: someone else's published work arriving in this branch. Teal — it's neither your edit
  // nor a publish of yours; it's incoming.
  pull: { label: 'pulled', cls: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
  genesis: { label: 'genesis', cls: 'bg-ink/10 text-ink-muted' },
}

/** A pull commit's provenance is the UPSTREAM commits it folded in — not draft checkpoints someone
 *  squashed. Same `source_commit_ids` drill-down, different story to tell about it. */
export const isPullCommit = (kind: unknown) => String(kind) === 'pull'

export const kindMeta = (kind: unknown) =>
  KIND_META[String(kind)] ?? { label: 'edit', cls: 'bg-ink/10 text-ink-muted' }
