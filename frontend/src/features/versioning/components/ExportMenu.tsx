/**
 * ExportMenu — "Export CSV", with what each file holds: one row per change, or one per changed
 * field and property. Opens on click, closes on a pick, Esc or a click elsewhere; arrow keys move
 * between the choices.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Download, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ExportDetail = 'changes' | 'properties'

const CHOICES: { detail: ExportDetail; title: string; about: string }[] = [
  { detail: 'changes', title: 'One row per change', about: 'What changed, how, its type and name' },
  { detail: 'properties', title: 'Property by property', about: 'One row per changed field or property, before and after' },
]

export function ExportMenu({ onExport, busy = false, label = 'Export CSV', count, className }: {
  onExport: (detail: ExportDetail) => void
  /** A file is being made. */
  busy?: boolean
  label?: string
  /** How many changes the file holds, said in the menu. */
  count?: number
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!open) return
    items.current[0]?.focus()
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); return }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const at = items.current.findIndex((b) => b === document.activeElement)
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + CHOICES.length) % CHOICES.length
    items.current[next]?.focus()
  }

  return (
    <div ref={root} className={cn('relative inline-flex', className)} onKeyDown={onKey}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] text-[12px] font-semibold text-ink-secondary hover:text-ink disabled:opacity-60">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Download className="w-3.5 h-3.5" aria-hidden />}
        {busy ? 'Preparing…' : label}
        <ChevronDown className="w-3 h-3 opacity-70" aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label={label}
          className="absolute right-0 top-full mt-1 z-30 w-64 p-1 rounded-xl bg-canvas-elevated border border-glass-border shadow-glass-lg">
          {count !== undefined && (
            <p className="px-2.5 pt-1.5 pb-1 text-[10.5px] text-ink-muted">{count.toLocaleString()} {count === 1 ? 'change' : 'changes'}, as filtered</p>
          )}
          {CHOICES.map((c, i) => (
            <button key={c.detail} ref={(el) => { items.current[i] = el }} type="button" role="menuitem"
              onClick={() => { setOpen(false); onExport(c.detail) }}
              className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-black/[0.04] dark:hover:bg-white/[0.06] focus:outline-none focus-visible:bg-accent-lineage/10">
              <span className="block text-[12.5px] font-semibold text-ink">{c.title}</span>
              <span className="block text-[11px] text-ink-muted">{c.about}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
