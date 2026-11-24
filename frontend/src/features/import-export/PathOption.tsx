/**
 * PathOption — the switch for whether an export says where each entity sits: its parent and path,
 * the five informational columns (`lib/ancestryColumns`). The data export and the view export
 * show the same one, bound to the one remembered choice (`exportWithPath` in `store/preferences`).
 */
import { FolderTree } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ANCESTRY_COLUMNS } from '@/lib/ancestryColumns'
import { HoverTip } from '@/components/ui/HoverTip'

export function PathOption({ on, onChange, technical }: { on: boolean; onChange: (on: boolean) => void; technical: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={cn('w-full text-left flex items-start gap-3 px-3.5 py-3 rounded-xl border transition-colors duration-150',
        on ? 'border-indigo-500/60 bg-indigo-50/40 dark:bg-indigo-950/15' : 'border-glass-border hover:border-glass-border-hover')}>
      <FolderTree className={cn('w-4 h-4 mt-0.5 flex-shrink-0', on ? 'text-indigo-500' : 'text-ink-muted')} />
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-semibold text-ink">Include where each entity sits (parent and path)</span>
        <span className="block text-[11px] text-ink-muted mt-0.5 leading-relaxed">
          {technical ? (
            <>
              Adds{' '}
              <HoverTip label="One read of containment for every thousand entities"
                detail="Lists in NDJSON and JSON; one cell in a spreadsheet, a path reading A / B and its URNs a; b.">
                <span className="font-mono underline decoration-dotted underline-offset-2 cursor-help">{ANCESTRY_COLUMNS.join(', ')}</span>
              </HoverTip>
              . Informational: an import skips them.
            </>
          ) : 'Each entity says what it sits in, all the way to the top. Skipped when you import the file back.'}
        </span>
      </span>
      <span aria-hidden className={cn('relative mt-0.5 w-8 h-[18px] rounded-full flex-shrink-0 transition-colors',
        on ? 'bg-indigo-500' : 'bg-black/15 dark:bg-white/15')}>
        <span className={cn('absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform',
          on ? 'translate-x-[16px]' : 'translate-x-[2px]')} />
      </span>
    </button>
  )
}
