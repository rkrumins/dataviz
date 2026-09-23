/**
 * What changed between two versions of a view's design, as a person reviews it: the label
 * (name, description, icon, tags, kind), the layers, the placements, and any other settings.
 * Counts are exact; the lists under them are samples (the server caps them).
 */
import { ArrowRight, Minus, Plus, Shuffle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ViewDefinitionDiff } from '@/services/viewVersionsApiService'
import { pluralize } from '@/features/view-transfer/format'

const FIELD_LABEL: Record<string, string> = {
  name: 'Name', description: 'Description', icon: 'Icon', tags: 'Tags', viewType: 'Kind of view',
}

function show(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'none'
  if (value === null || value === undefined || value === '') return 'empty'
  return String(value)
}

function lastSegment(urn: string): string {
  return urn.split(/[,:/]/).filter(Boolean).pop() ?? urn
}

export function VersionDiffView({ diff, layerNames = {} }: {
  diff: ViewDefinitionDiff
  layerNames?: Record<string, string>
}) {
  if (diff.identical) {
    return <p className="rounded-xl border border-glass-border px-4 py-6 text-center text-xs text-ink-muted">These two are the same design.</p>
  }
  const a = diff.assignments
  const nameOf = (id: string | null) => (id ? layerNames[id] ?? id : 'none')
  return (
    <div className="space-y-4">
      {diff.metadata.length > 0 && (
        <Section title="Details">
          {diff.metadata.map(m => (
            <Row key={m.field} tone="changed">
              <span className="font-semibold text-ink-secondary w-24 shrink-0">{FIELD_LABEL[m.field] ?? m.field}</span>
              <span className="truncate text-ink-muted line-through">{show(m.from)}</span>
              <ArrowRight className="w-3 h-3 shrink-0 text-ink-muted" />
              <span className="truncate text-ink">{show(m.to)}</span>
            </Row>
          ))}
        </Section>
      )}

      {(diff.layers.added.length + diff.layers.removed.length + diff.layers.changed.length > 0 || diff.layers.reordered) && (
        <Section title="Layers">
          {diff.layers.added.map(l => <Row key={`+${l.id}`} tone="added"><span className="truncate">{l.name ?? l.id}</span></Row>)}
          {diff.layers.removed.map(l => <Row key={`-${l.id}`} tone="removed"><span className="truncate">{l.name ?? l.id}</span></Row>)}
          {diff.layers.changed.map(l => (
            <Row key={`~${l.id}`} tone="changed">
              <span className="truncate">{l.name ?? l.id}</span>
              <span className="text-ink-muted truncate">: {l.fields.join(', ')}</span>
            </Row>
          ))}
          {diff.layers.reordered && <Row tone="changed"><span>Layers were reordered</span></Row>}
        </Section>
      )}

      {a.added + a.removed + a.moved + a.modified > 0 && (
        <Section title="Placements" detail={[
          a.added ? `${a.added.toLocaleString()} placed` : '',
          a.removed ? `${a.removed.toLocaleString()} unplaced` : '',
          a.moved ? `${a.moved.toLocaleString()} moved` : '',
          a.modified ? `${a.modified.toLocaleString()} adjusted` : '',
        ].filter(Boolean).join(' · ')}>
          {a.samples.added.slice(0, 20).map(u => <Row key={`+${u}`} tone="added"><span className="font-mono truncate" title={u}>{lastSegment(u)}</span></Row>)}
          {a.samples.removed.slice(0, 20).map(u => <Row key={`-${u}`} tone="removed"><span className="font-mono truncate" title={u}>{lastSegment(u)}</span></Row>)}
          {a.samples.moved.slice(0, 20).map(m => (
            <Row key={`>${m.urn}`} tone="moved">
              <span className="font-mono truncate" title={m.urn}>{lastSegment(m.urn)}</span>
              <span className="text-ink-muted truncate">{nameOf(m.from)} → {nameOf(m.to)}</span>
            </Row>
          ))}
          {(a.added + a.removed + a.moved > 60 || a.truncated) && (
            <p className="px-3 py-1.5 text-[10px] text-ink-muted">Showing a sample.</p>
          )}
        </Section>
      )}

      {diff.settings.length > 0 && (
        <Section title="Other settings" detail={pluralize(diff.settings.length, 'change')}>
          <p className="px-3 py-2 text-[11px] font-mono text-ink-muted leading-relaxed break-words">{diff.settings.join(' · ')}</p>
        </Section>
      )}
    </div>
  )
}

function Section({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-1.5">
        <h5 className="text-xs font-bold text-ink">{title}</h5>
        {detail && <span className="text-[11px] text-ink-muted">{detail}</span>}
      </div>
      <div className="rounded-xl border border-glass-border divide-y divide-glass-border/50">{children}</div>
    </section>
  )
}

const TONE = {
  added: { icon: Plus, cls: 'text-emerald-500' },
  removed: { icon: Minus, cls: 'text-rose-500' },
  moved: { icon: Shuffle, cls: 'text-indigo-500' },
  changed: { icon: ArrowRight, cls: 'text-amber-500' },
} as const

function Row({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  const Icon = TONE[tone].icon
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-ink min-w-0">
      <Icon className={cn('w-3 h-3 shrink-0', TONE[tone].cls)} />
      {children}
    </div>
  )
}
