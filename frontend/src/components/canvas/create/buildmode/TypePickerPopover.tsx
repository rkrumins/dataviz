/**
 * TypePickerPopover — the searchable entity-type picker popover, shared by
 * `BuildGrid` (the Type/fill-down cells) and `BuildOutline` (Task 4's per-row
 * type change). Extracted from `BuildGrid.tsx` so both surfaces use the
 * identical search+pick UI instead of duplicating it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import type { EntityTypeSchema } from '@/types/schema'

/** The ontology-colored icon chip — matches BuildOutline's/BuildGrid's/BuildPanel's TypeChip. */
function TypeChip({ type }: { type?: EntityTypeSchema }) {
  return (
    <span
      className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: `${type?.visual?.color}20`, color: type?.visual?.color }}
    >
      <DynamicIcon name={type?.visual?.icon ?? 'Box'} className="w-3 h-3" />
    </span>
  )
}

/** Closes an open popover on an outside mousedown. */
function useOutsideDismiss(ref: React.RefObject<HTMLElement | null>, onDismiss: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onDismiss])
}

export function TypePickerPopover({
  entityTypes, selectedId, onPick, onClose,
}: {
  entityTypes: EntityTypeSchema[]
  selectedId: string | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  useOutsideDismiss(ref, onClose)

  const filtered = useMemo(() => {
    if (!q.trim()) return entityTypes
    const s = q.toLowerCase()
    return entityTypes.filter((t) => t.name.toLowerCase().includes(s) || t.id.toLowerCase().includes(s))
  }, [entityTypes, q])

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-1 z-30 w-56 bg-canvas-elevated/98 backdrop-blur-xl border border-glass-border rounded-xl shadow-lg overflow-hidden"
    >
      <div className="p-1.5 border-b border-glass-border">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search types…"
          className="w-full px-2 py-1 text-xs bg-transparent focus:outline-none text-ink placeholder:text-ink-muted/50"
        />
      </div>
      <div className="max-h-48 overflow-y-auto custom-scrollbar p-1 space-y-0.5">
        {filtered.length === 0 && <div className="text-center py-3 text-[11px] text-ink-muted">No matching types.</div>}
        {filtered.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1 rounded-lg text-left transition-colors',
              t.id === selectedId ? 'bg-accent-lineage/10 ring-1 ring-accent-lineage/30' : 'hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <TypeChip type={t} />
            <span className="flex-1 min-w-0 text-xs text-ink truncate">{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
