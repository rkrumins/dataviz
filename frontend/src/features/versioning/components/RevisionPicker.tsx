/**
 * RevisionPicker — one end of a comparison: a revision of Published, or Published as it is now.
 *
 * The trigger says which (its number, when, who, what); the list under it is Published's revisions
 * newest first, a page at a time (`useHistoryPages`, keyset by `before`), so choosing one from years
 * back costs the pages scrolled through, never the whole history.
 */
import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Loader2, Radio } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DateTime } from '@/components/ui/DateTime'
import { Skeleton } from '@/components/ui/Skeleton'
import { useHistoryPages, useRevision } from '../hooks/useVersioning'
import { ownerName } from '../model/branchVocab'

type Commit = Record<string, unknown>

export function RevisionPicker({
  wsId, graphId, label, value, headSeq, allowNow = false, onChange,
}: {
  wsId: string
  graphId: string
  /** "From" or "To". */
  label: string
  /** A revision's seq, or null for Published as it is now. */
  value: number | null
  headSeq: number | null
  allowNow?: boolean
  onChange: (seq: number | null) => void
}) {
  const [open, setOpen] = useState(false)
  const pages = useHistoryPages(wsId, graphId, { kind: 'graph' }, open)
  const commits = (pages.data?.pages ?? []).flatMap((p) => p.commits as Commit[])
  const userNames = Object.assign({}, ...(pages.data?.pages ?? []).map((p) => p.userNames ?? {}))
  const chosen = useRevision(wsId, graphId, value)
  const commit = chosen.data?.commit
  const isNow = value == null

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="group w-full h-full min-w-0 flex flex-col text-left rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2 hover:border-indigo-500/40 hover:bg-indigo-500/[0.04] transition-colors data-[state=open]:border-indigo-500/60 data-[state=open]:ring-2 data-[state=open]:ring-indigo-500/20"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/80">{label}</span>
            <ChevronDown className="w-3.5 h-3.5 text-ink-muted/60 group-data-[state=open]:rotate-180 transition-transform" />
          </span>
          {isNow ? (
            <span className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Radio className="w-3.5 h-3.5 text-emerald-500" /> Now
              {headSeq != null && <span className="text-[11px] font-normal text-ink-muted">· Revision #{headSeq}</span>}
            </span>
          ) : (
            <>
              <span className="mt-0.5 block text-sm font-semibold text-ink truncate">
                Revision #{value}
                {commit?.message ? <span className="font-normal text-ink-muted"> · {String(commit.message)}</span> : null}
              </span>
              <span className="block text-[11px] text-ink-muted truncate">
                {chosen.isLoading ? <Skeleton className="inline-block h-3 w-32 align-middle" /> : commit ? (
                  <>
                    <DateTime at={String(commit.created_at)} variant="calendar" />
                    {commit.actor ? <> · {ownerName(String(commit.actor), chosen.data?.userNames)}</> : null}
                  </>
                ) : null}
              </span>
            </>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-[9999] w-[22rem] max-w-[92vw] bg-canvas border border-glass-border rounded-2xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100"
        >
          <div className="max-h-[22rem] overflow-y-auto custom-scrollbar p-1" role="listbox" aria-label={`${label} revision`}>
            {allowNow && (
              <PickRow selected={isNow} onSelect={() => { onChange(null); setOpen(false) }}>
                <span className="flex items-center gap-1.5 font-semibold text-ink">
                  <Radio className="w-3.5 h-3.5 text-emerald-500" /> Now
                </span>
                <span className="text-[11px] text-ink-muted">Published as it is{headSeq != null ? ` · Revision #${headSeq}` : ''}</span>
              </PickRow>
            )}
            {pages.isLoading && Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="px-2.5 py-2"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="mt-1.5 h-3 w-1/3" /></div>
            ))}
            {commits.map((c) => {
              const seq = c.commit_seq as number
              return (
                <PickRow key={String(c.commit_id)} selected={value === seq} onSelect={() => { onChange(seq); setOpen(false) }}>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="shrink-0 font-mono text-[11px] text-ink-muted">#{seq}</span>
                    <span className="truncate font-medium text-ink">{String(c.message || c.kind || 'Revision')}</span>
                  </span>
                  <span className="text-[11px] text-ink-muted truncate">
                    <DateTime at={String(c.created_at)} />
                    {c.actor ? <> · {ownerName(String(c.actor), userNames)}</> : null}
                  </span>
                </PickRow>
              )
            })}
            {pages.hasNextPage && (
              <button
                onClick={() => pages.fetchNextPage()}
                disabled={pages.isFetchingNextPage}
                className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/[0.06] rounded-lg"
              >
                {pages.isFetchingNextPage && <Loader2 className="w-3 h-3 animate-spin" />} Older revisions
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function PickRow({ selected, onSelect, children }: { selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[13px] transition-colors',
        selected ? 'bg-indigo-500/10' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
      )}
    >
      <span className="min-w-0 flex-1 flex flex-col">{children}</span>
      {selected && <Check className="w-4 h-4 shrink-0 text-indigo-600 dark:text-indigo-300" />}
    </button>
  )
}
