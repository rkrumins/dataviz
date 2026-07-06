/**
 * AddLayerColumn — a draft-only "+ Add layer" affordance that sits after the layer columns in the
 * Context View, so users can create the layers they'll organise their nodes into. Collapsed it's a
 * dashed "Add layer" tile; clicking reveals an inline name field (name it right away — no rename-later
 * needed). Submitting calls `onAdd(name)`, which appends a ViewLayerConfig to the view's layout (see
 * ContextViewCanvas.addLayer) — the new column renders immediately and new nodes can be created in it.
 */
import { useState } from 'react'
import * as LucideIcons from 'lucide-react'

export function AddLayerColumn({ onAdd }: { onAdd: (name: string) => void }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const submit = () => {
    const n = name.trim()
    if (!n) return
    onAdd(n)
    setName('')
    setAdding(false)
  }
  const cancel = () => {
    setName('')
    setAdding(false)
  }

  return (
    // self-start: don't stretch to the full-height flex row (would float the "+" in dead centre).
    // pointer-events-auto: the columns wrapper is pointer-events-none (so edge strokes below stay
    // hittable); interactive children MUST opt back in or they're unclickable.
    <div className="flex-shrink-0 w-64 self-start flex flex-col pointer-events-auto">
      {!adding ? (
        <button
          onClick={() => setAdding(true)}
          title="Create a new layer"
          className="group min-h-[128px] flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-glass-border hover:border-accent-lineage/50 hover:bg-accent-lineage/[0.03] text-ink-muted hover:text-accent-lineage transition-colors"
        >
          <div className="w-10 h-10 rounded-full bg-black/[0.03] dark:bg-white/[0.04] group-hover:bg-accent-lineage/10 flex items-center justify-center transition-colors">
            <LucideIcons.Plus className="w-5 h-5" strokeWidth={2.2} />
          </div>
          <span className="text-sm font-medium">Add layer</span>
        </button>
      ) : (
        <div className="rounded-2xl border-2 border-dashed border-accent-lineage/40 bg-accent-lineage/[0.03] p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-2">New layer</p>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') cancel()
            }}
            placeholder="Layer name"
            className="w-full px-3 py-2 rounded-xl bg-canvas-overlay border border-glass-border text-sm text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage transition-colors mb-2.5"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={submit}
              disabled={!name.trim()}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-lineage text-white text-sm font-medium hover:bg-accent-lineage/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <LucideIcons.Plus className="w-3.5 h-3.5" strokeWidth={2.4} /> Add
            </button>
            <button
              onClick={cancel}
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
