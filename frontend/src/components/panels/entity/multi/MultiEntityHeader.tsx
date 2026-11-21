/**
 * The comparison's header: how many entities it holds and of which types, who they are (the first
 * few, and all of them on request — each shown on the canvas or opened in one click), and, when
 * the canvas selection has moved on since it opened, the way to compare that instead.
 */
import { useState } from 'react'
import { AlertCircle, ChevronDown, Layers, LocateFixed, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { DrawerHeader } from '../../shell/DrawerShell'
import { DrawerTopBar } from '../../shell/DrawerTopBar'
import { MemberList, type Member } from './ValueBreakdown'

const PREVIEW = 5

export interface TypeCount { id: string; label: string; count: number; color: string }

export function MultiEntityHeader({
  titleId, ids, types, memberOf, gone, editable, selectionNow, onUseSelection, onClose, onFocusNode, onOpenNode, onLocateAll,
}: {
  titleId: string
  /** The entities still on the canvas, in order. */
  ids: readonly string[]
  types: readonly TypeCount[]
  memberOf: (id: string) => Member
  /** How many it was opened on that are no longer loaded. */
  gone: number
  editable: boolean
  /** The canvas selection, when it differs from what is compared. */
  selectionNow: number
  onUseSelection: () => void
  onClose: () => void
  onFocusNode?: (id: string) => void | Promise<unknown>
  onOpenNode: (id: string) => void
  onLocateAll?: () => void
}) {
  const [listOpen, setListOpen] = useState(false)
  const preview = ids.slice(0, PREVIEW)
  const more = ids.length - preview.length

  return (
    <DrawerHeader className="bg-gradient-to-br from-accent-lineage/[0.07] to-transparent">
      <DrawerTopBar
        badge={<Badge tone="accent" size="md" caps>Selection</Badge>}
        closeLabel="Close details"
        onClose={onClose}
        onFocusNode={onFocusNode}
      />
      <div className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-lineage/15 text-accent-lineage shadow-sm shadow-accent-lineage/10">
          <Layers className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} tabIndex={-1} className="text-lg font-semibold leading-tight text-ink outline-none">
            {ids.length.toLocaleString()} entities
          </h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            {editable ? 'What they share, and where they differ — change it for all at once.' : 'What they share, and where they differ.'}
          </p>
        </div>
        {onLocateAll && (
          <Button size="sm" variant="ghost" leftIcon={LocateFixed} onClick={onLocateAll}>Show all</Button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {types.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-canvas px-2 py-1 text-[11px] text-ink">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} aria-hidden />
            <span className="tabular-nums font-semibold">{t.count.toLocaleString()}</span> {t.label}
          </span>
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        {preview.map((id) => {
          const m = memberOf(id)
          return (
            <HoverTip key={id} label={`Show ${m.name} on the canvas`} detail="Open it from the list below">
              <button type="button" onClick={() => void onFocusNode?.(id)}
                className="max-w-[10rem] truncate rounded-md bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-ink-secondary hover:text-ink hover:bg-black/[0.07] dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                {m.name}
              </button>
            </HoverTip>
          )
        })}
        <button type="button" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}
          className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
          {more > 0 ? `and ${more.toLocaleString()} more` : 'List them'}
          <ChevronDown className={cn('w-3 h-3 transition-transform', listOpen && 'rotate-180')} aria-hidden />
        </button>
      </div>
      {listOpen && (
        <div className="mt-1.5 max-h-56 overflow-y-auto custom-scrollbar rounded-lg border border-glass-border bg-canvas">
          <MemberList ids={ids} memberOf={memberOf} className="ml-0 my-1" onFocusNode={(id) => void onFocusNode?.(id)} onOpenNode={onOpenNode} />
        </div>
      )}

      {gone > 0 && (
        <p className="mt-2.5 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          {gone.toLocaleString()} of the selection {gone === 1 ? "isn't" : "aren't"} on the canvas any more — {editable ? 'edits here reach' : 'this compares'} the {ids.length.toLocaleString()} still shown.
        </p>
      )}
      {selectionNow >= 2 && (
        <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-accent-lineage/25 bg-accent-lineage/[0.05] px-2.5 py-1.5">
          <span className="flex-1 min-w-0 text-[11px] text-ink-secondary">The selection on the canvas has changed.</span>
          <Button size="sm" variant="ghost" leftIcon={RefreshCw} className="h-6 px-2 text-2xs" onClick={onUseSelection}>
            Compare those {selectionNow.toLocaleString()}
          </Button>
        </div>
      )}
    </DrawerHeader>
  )
}
