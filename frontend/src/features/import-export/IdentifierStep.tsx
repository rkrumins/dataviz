/**
 * IdentifierStep — the identifier each thing in a file is given, settled before anything is sent.
 *
 * In the Playground every thing has an identifier of its own (its `id`, kept equal to its urn):
 * how its connections name it, and how the next file finds it again. An import there refuses a row
 * that gives none ("Needs an identifier (urn or id)"), so the guided imports — Bring your own data,
 * and Import on a Playground graph — show what each thing will be identified by first: the column
 * it is read from (guessed from its name; any other may be chosen), its first values, and how many
 * things have none or share one. Until every thing has one, and no two share one, the import
 * waits (`check.ok`). A standard file whose rows give none can take one from a column; a file the
 * server reads is checked there as it loads, and the step says so.
 *
 * `useIdentifierChoice` holds the choice and the read as it settles it; the import sends that read.
 */
import { useId } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Fingerprint, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { Badge } from '@/components/ui/Badge'
import { HoverTip } from '@/components/ui/HoverTip'
import { Select } from '@/components/ui/Select'
import type { IdentifierCheck } from './identifierCheck'
import type { IdentifierChoice } from './useIdentifierChoice'

const n = (count: number) => count.toLocaleString('en-US')
const plural = (count: number, one: string, many = `${one}s`) => `${n(count)} ${count === 1 ? one : many}`

export function IdentifierStep({ choice, className }: { choice: IdentifierChoice; className?: string }) {
  const selectId = useId()
  const { check } = choice
  if (!check) return null
  if (check.from === 'server') {
    return (
      <p className={cn('flex items-start gap-1.5 rounded-xl border border-glass-border bg-canvas/60 px-3 py-2 text-[11px] text-ink-secondary', className)}>
        <Info className="mt-px w-3.5 h-3.5 shrink-0 text-violet-500" aria-hidden />
        This file is read on the server as it loads: each thing needs its urn or an <code className="font-mono">id</code>,
        and a row that gives neither is listed as refused, with why.
      </p>
    )
  }
  // A things CSV's column may always change; a standard file's rows take one from a column only
  // when some give none (or one has been mapped, which may change too).
  const choosable = check.from === 'column' || (check.from === 'standard' && (check.blank > 0 || !!check.column))
  return (
    <div role="group" aria-label="What identifies each thing" className={cn('rounded-2xl border p-3.5 transition-colors',
      check.ok ? 'border-glass-border bg-canvas/60' : 'border-amber-500/30 bg-amber-500/[0.04]', className)}>
      <div className="flex items-start gap-2.5">
        <span className="flex w-8 h-8 shrink-0 items-center justify-center rounded-xl border border-violet-500/25 bg-gradient-to-br from-violet-500/15 to-fuchsia-500/10 text-violet-600 dark:text-violet-300">
          <Fingerprint className="w-4 h-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] leading-snug text-ink-secondary">
            Each thing needs an identifier of its own: it’s how its connections name it, and how the next file finds it
            again. It becomes the thing’s <span className="font-semibold text-ink">Identifier</span>.
          </p>
          {check.from === 'key' && (
            <p className="mt-1.5 text-xs text-ink">Read from each thing’s <code className="rounded bg-black/[0.05] px-1 font-mono text-[11px] dark:bg-white/[0.08]">key</code>.</p>
          )}
          {check.from === 'standard' && !check.blank && !check.column && (
            <p className="mt-1.5 text-xs text-ink">Each row gives its <code className="font-mono text-[11px]">urn</code> or <code className="font-mono text-[11px]">id</code>.</p>
          )}
          {choosable && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label htmlFor={selectId} className="text-xs font-semibold text-ink-secondary">
                {check.from === 'column' ? 'Read from the column' : 'Rows without a urn or id take one from'}
              </label>
              {check.columns.length ? (
                <Select id={selectId} size="sm" className="min-w-[9rem]" value={check.column ?? ''}
                  onChange={(v) => choice.setColumn(v || null)}
                  options={[...(check.column ? [] : [{ value: '', label: 'Choose a column…' }]),
                    ...check.columns.map(c => ({ value: c, label: c }))]} />
              ) : (
                <span className="text-xs text-ink-muted">no column of its own could be one — give each row a urn or <code className="font-mono">id</code></span>
              )}
              {check.from === 'column' && choice.guessed && check.column && (
                <HoverTip label="Guessed from its name" detail="A column named key, id, identifier or urn. Choose another if that isn’t the one.">
                  <Badge tone="accent">Guessed</Badge>
                </HoverTip>
              )}
            </div>
          )}
        </div>
        <Badge tone={check.ok ? 'success' : 'warning'} size="md" className="shrink-0">
          {check.ok ? <><CheckCircle2 className="w-3 h-3" aria-hidden /> Ready</> : <><AlertTriangle className="w-3 h-3" aria-hidden /> To fix</>}
        </Badge>
      </div>

      {check.sample.length > 0 && (
        <div className="mt-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-muted">First values</p>
          <ul aria-label="First identifiers" className="mt-1 flex flex-wrap gap-1.5">
            {check.sample.map((v, i) => (
              <motion.li key={`${i}:${v}`} initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }}
                transition={{ ...MOTION.fieldEntry, delay: i * MOTION.fieldStagger }}
                className="max-w-[12rem] truncate rounded-lg border border-black/[0.07] bg-canvas-elevated px-2 py-0.5 font-mono text-[11px] text-ink dark:border-white/10"
                title={v}>
                {v}
              </motion.li>
            ))}
            {check.total - check.blank > check.sample.length && (
              <li className="px-1 py-0.5 text-[11px] text-ink-muted">and {n(check.total - check.blank - check.sample.length)} more</li>
            )}
          </ul>
        </div>
      )}

      <Counts check={check} />
    </div>
  )
}

function Counts({ check }: { check: IdentifierCheck }) {
  const dupRows = check.duplicates.reduce((sum, d) => sum + d.count, 0)
  return (
    <div aria-live="polite" className="mt-3 grid grid-cols-3 gap-2">
      <Count label={check.total === 1 ? 'thing' : 'things'} value={check.total} />
      <Count label="with none" value={check.blank} warn={check.blank > 0} />
      <Count label={check.duplicates.length === 1 ? 'value shared' : 'values shared'} value={check.duplicates.length} warn={check.duplicates.length > 0}
        detail={check.duplicates.length ? `${check.duplicates.slice(0, 3).map(d => `“${d.value}” ×${d.count}`).join(', ')}${check.duplicates.length > 3 ? ', …' : ''} — ${plural(dupRows, 'row')}` : undefined} />
    </div>
  )
}

function Count({ label, value, warn = false, detail }: { label: string; value: number; warn?: boolean; detail?: string }) {
  const body = (
    <p className={cn('rounded-xl border px-2.5 py-1.5',
      warn ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-black/[0.07] bg-canvas-elevated dark:border-white/10')}>
      <span className={cn('block text-base font-bold tabular-nums leading-tight', warn ? 'text-amber-700 dark:text-amber-300' : 'text-ink')}>{n(value)}</span>
      <span className="block text-[11px] text-ink-muted">{label}</span>
      {detail && <span className="mt-0.5 block truncate text-[10px] text-amber-700 dark:text-amber-400">{detail}</span>}
    </p>
  )
  return detail ? <HoverTip className="block min-w-0" label="Shared by more than one thing" detail={detail}>{body}</HoverTip> : body
}
