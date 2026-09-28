/**
 * ConflictChoices — settle a staged change that conflicts with someone else's edit, field by field.
 *
 * Each field both edits changed shows the value it had when the user opened it, theirs now, and
 * the user's, with a choice between the last two. Applying rebases the user's edit onto the
 * current value (`resolveConflict`): chosen fields keep the user's value, the rest take theirs,
 * and everything else either side changed is kept. Nothing is saved until Review & Save.
 */
import { useId, useState } from 'react'
import { Check, GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { StagedChange } from '@/store/stagedChangesStore'
import { resolveConflict, type ConflictChoice } from '../model/rebaseStagedChange'

const FIELD_LABEL: Record<string, string> = {
  displayName: 'Name', description: 'Description', qualifiedName: 'Qualified name',
  sourceSystem: 'Source system', tags: 'Tags', entityType: 'Type', confidence: 'Confidence',
}

function labelOf(path: string[]): string {
  if (path[0] === 'properties' && path.length > 1) return path.slice(1).join('.')
  return FIELD_LABEL[path[0]] ?? path.join('.')
}

/** A value as shown in a choice — a side that no longer has the field says it was removed. */
function show(v: unknown, base?: unknown): string {
  if (v === undefined || v === null) return base === undefined || base === null ? '— none —' : '— removed —'
  if (typeof v === 'string') return v === '' ? '""' : v
  try { return JSON.stringify(v) } catch { return String(v) }
}

export function ConflictChoices({ change }: { change: StagedChange }) {
  const conflict = change.conflict!
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>(
    () => Object.fromEntries(conflict.fields.map((f) => [f.key, 'mine' as const])),
  )
  const setAll = (c: ConflictChoice) => setChoices(Object.fromEntries(conflict.fields.map((f) => [f.key, c])))
  const baseId = useId()

  if (conflict.current.deleted) {
    return (
      <div className="mt-2.5 rounded-xl border border-rose-400/30 bg-rose-500/[0.08] px-3 py-2.5">
        <p className="text-[12px] text-rose-100/90">It was deleted meanwhile — there is nothing left to edit.</p>
        <button type="button" onClick={() => resolveConflict(change.id, {})}
          className="mt-2 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold text-rose-100 bg-rose-500/20 border border-rose-400/30 hover:bg-rose-500/30 transition-colors">
          Drop this change
        </button>
      </div>
    )
  }

  return (
    <div className="mt-2.5 rounded-xl border border-amber-400/30 bg-amber-500/[0.07] px-3 py-2.5" data-testid="conflict-choices">
      <div className="flex items-center gap-2">
        <GitMerge className="w-3.5 h-3.5 text-amber-300 flex-shrink-0" aria-hidden />
        <p className="text-[12px] font-semibold text-amber-100">
          {conflict.fields.length === 1 ? '1 field' : `${conflict.fields.length} fields`} changed by someone else
        </p>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setAll('mine')}
            className="px-2 py-0.5 rounded-md text-[10.5px] font-semibold text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
            Keep all mine
          </button>
          <button type="button" onClick={() => setAll('theirs')}
            className="px-2 py-0.5 rounded-md text-[10.5px] font-semibold text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors">
            Use all theirs
          </button>
        </div>
      </div>
      <ul className="mt-2 space-y-2">
        {conflict.fields.map((f, i) => {
          const name = `${baseId}-${i}`
          return (
            <li key={f.key} className="rounded-lg bg-black/25 border border-white/[0.06] px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-semibold text-white/90 truncate" title={f.key}>{labelOf(f.path)}</span>
                <span className="text-[10.5px] text-white/40 truncate" title={show(f.base)}>was {show(f.base)}</span>
              </div>
              <div role="radiogroup" aria-label={`Keep which value of ${labelOf(f.path)}`} className="mt-1.5 grid grid-cols-2 gap-1.5">
                {(['mine', 'theirs'] as const).map((side) => {
                  const on = choices[f.key] === side
                  return (
                    <label key={side} className={cn(
                      'flex items-start gap-2 rounded-lg border px-2 py-1.5 cursor-pointer transition-colors',
                      on ? 'border-amber-300/60 bg-amber-400/[0.12]' : 'border-white/[0.08] hover:bg-white/[0.04]',
                    )}>
                      <input type="radio" name={name} value={side} checked={on} className="sr-only"
                        onChange={() => setChoices((c) => ({ ...c, [f.key]: side }))} />
                      <span className={cn('mt-0.5 w-3.5 h-3.5 rounded-full border flex items-center justify-center flex-shrink-0',
                        on ? 'border-amber-300 bg-amber-300' : 'border-white/30')}>
                        {on && <Check className="w-2.5 h-2.5 text-black" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[10px] uppercase tracking-[0.08em] font-bold text-white/45">
                          {side === 'mine' ? 'Yours' : 'Theirs'}
                        </span>
                        <span className="block text-[11.5px] text-white/85 break-words">{show(side === 'mine' ? f.mine : f.theirs, f.base)}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mt-2.5 flex items-center justify-end">
        <button type="button" onClick={() => resolveConflict(change.id, choices)}
          className="px-3 py-1.5 rounded-lg text-[12px] font-bold text-black bg-amber-300 hover:bg-amber-200 transition-colors">
          Use these values
        </button>
      </div>
    </div>
  )
}
