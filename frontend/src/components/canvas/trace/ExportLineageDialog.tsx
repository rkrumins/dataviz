/**
 * ExportLineageDialog — everything some entities reach, worked out on the
 * server and written to a file (2026-11-18).
 *
 * The browser holds what it has walked; this is the COMPLETE answer, however
 * large: the server resolves the starting points and their sources and
 * consumers a step at a time (`services/memberSetExport`), keeping where it
 * got to, and the file streams from what it kept. Two ways in:
 *
 *  • the trace dock's "Everything it reaches…" — the trace's own question,
 *    its seeds and its reach, said in words and not changed here;
 *  • Advanced Search's "with sources & consumers" — a search's matches as the
 *    starting points, and the reader chooses how far each way to go.
 *
 * Every limit the server reached is said, never silent. Closing stops
 * following the set; the server keeps what it worked out for a while, and the
 * same question asked again carries on from there.
 *
 * Each entity says where it sits (its parent and path) as this file always
 * has, unless the reader switches it off: their choice is remembered for the
 * next one (`traceExportWithPath`).
 */
import { motion } from 'framer-motion'
import { Check, Download, FileDown, Network, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Backdrop } from '@/components/ui/Backdrop'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { describeNarrow, truncationNotes } from '@/features/narrow/model'
import { cn } from '@/lib/utils'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { httpStatusOf } from '@/services/graphRequestFailure'
import { triggerBrowserDownload } from '@/services/importExportApiService'
import { followMemberSet } from '@/services/memberSetExport'
import { usePreferencesStore } from '@/store/preferences'
import type { Depth, MembershipSpec } from '@/types/membership'
import type { MemberSetFormat, MemberSetStage, MemberSetStatus } from '@/types/memberSet'

export interface ExportLineageDialogProps {
  /** The view the question is asked in (its boundary bounds a search's matches). */
  viewId: string | null
  /** The starting points and how far they reach. */
  spec: MembershipSpec
  /** Words for the starting points: a name, "2 entities", "the matches of your search". */
  seedsLabel: string
  /** The reader chooses how far each way, and whether to bring what is inside. */
  adjustable?: boolean
  onClose: () => void
}

const FORMATS: ReadonlyArray<{ value: MemberSetFormat; label: string; description: string }> = [
  { value: 'csv', label: 'CSV', description: 'Opens in any spreadsheet. Flows come as a second file.' },
  { value: 'ndjson', label: 'NDJSON', description: 'One JSON object a line, for scripts.' },
  { value: 'json', label: 'JSON', description: 'One document: the question, the entities, the flows.' },
]

const STAGE_WORDS: Record<MemberSetStage, string> = {
  seeds: 'Finding the starting points',
  inside: 'Reading what is inside them',
  upstream: 'Following the sources',
  downstream: 'Following the consumers',
  partnerInside: 'Reading what is inside the sources and consumers',
  done: 'Finishing',
}

/** How far through its stages a set is — the total is not known until the end. */
const STAGE_PERCENT: Record<MemberSetStage, number> = {
  seeds: 5, inside: 20, upstream: 40, downstream: 65, partnerInside: 85, done: 95,
}

/** The reach a reader can pick: 1–25 hops or the whole way. */
const HOPS: readonly Depth[] = [0, 1, 2, 3, 5, 10, 25, 'all']
const hopsText = (d: Depth) => (d === 'all' ? 'the whole way' : d === 0 ? 'none' : `${d} hop${d === 1 ? '' : 's'}`)

type Phase =
  | { kind: 'choose' }
  | { kind: 'working'; answer: MemberSetStatus | null }
  | { kind: 'ready'; answer: MemberSetStatus; files: Array<{ url: string; name: string }> }
  | { kind: 'failed'; message: string }

function failureMessage(e: unknown): string {
  const status = httpStatusOf(e)
  if (status === 403) return 'Exporting is turned off here, or you can’t read this data.'
  if (status === 404) return 'That export has expired — export again.'
  if (status === 429) return 'The graph is busy with other work — try again in a moment.'
  if (status === 501) return 'This kind of data source can’t follow lineage on the server.'
  return 'The export stopped. What the server worked out is kept a while — export again to carry on.'
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lineage'

export function ExportLineageDialog({ viewId, spec: initial, seedsLabel, adjustable = false, onClose }: ExportLineageDialogProps) {
  const provider = useGraphProvider()
  const [format, setFormat] = useState<MemberSetFormat>('csv')
  const [withFlows, setWithFlows] = useState(false)
  const [withDescription, setWithDescription] = useState(true)
  const withPath = usePreferencesStore((s) => s.traceExportWithPath)
  const setWithPath = usePreferencesStore((s) => s.setTraceExportWithPath)
  const [upstream, setUpstream] = useState<Depth>(adjustable ? 1 : initial.expand.upstream)
  const [downstream, setDownstream] = useState<Depth>(adjustable ? 1 : initial.expand.downstream)
  const [inside, setInside] = useState(adjustable ? false : initial.expand.partnerChildren !== 0)
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' })
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => running.current?.abort(), [])

  const spec: MembershipSpec = adjustable
    ? { ...initial, expand: { ...initial.expand, upstream, downstream, partnerChildren: inside ? 1 : 0 } }
    : initial
  const sentence = describeNarrow(spec, seedsLabel)

  const start = () => {
    if (!(provider instanceof RemoteGraphProvider)) return
    const controller = new AbortController()
    running.current = controller
    setPhase({ kind: 'working', answer: null })
    followMemberSet(provider, viewId, { spec, includeEdges: withFlows }, {
      signal: controller.signal,
      onUpdate: (answer) => {
        if (!controller.signal.aborted && answer.status === 'running') setPhase({ kind: 'working', answer })
      },
    }).then((answer) => {
      if (controller.signal.aborted) return
      if (!answer.downloadToken) {
        setPhase({ kind: 'failed', message: 'It finished without a download link — export again.' })
        return
      }
      const columns = withDescription ? ['description', 'tags'] : []
      const base = `lineage-${slug(seedsLabel)}-${new Date().toISOString().slice(0, 10)}`
      const ext = format === 'csv' ? 'csv' : format === 'ndjson' ? 'ndjson' : 'json'
      const files = [{ url: provider.memberSetDownloadUrl(answer.setId, answer.downloadToken, format, 'nodes', columns, withPath), name: `${base}.${ext}` }]
      // JSON carries its flows in the one document; the others as a file of their own.
      if (withFlows && format !== 'json') {
        files.push({ url: provider.memberSetDownloadUrl(answer.setId, answer.downloadToken, format, 'edges'), name: `${base}-flows.${ext}` })
      }
      setPhase({ kind: 'ready', answer, files })
      for (const f of files) triggerBrowserDownload(f.url, f.name)
    }).catch((e: unknown) => {
      if (controller.signal.aborted) return
      setPhase({ kind: 'failed', message: e instanceof Error && e.message === 'The server could not work this out.' ? e.message : failureMessage(e) })
    })
  }

  const stop = () => {
    running.current?.abort()
    setPhase({ kind: 'choose' })
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <>
      <Backdrop open={true} onClick={onClose} zClassName="z-[60]" className="bg-black/50" />
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.15 }}
          className={cn(
            'pointer-events-auto relative w-full max-w-lg rounded-2xl overflow-hidden flex flex-col max-h-[88vh]',
            'bg-canvas-elevated border border-slate-200 dark:border-glass-border shadow-2xl shadow-black/40',
          )}
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-lineage-title"
        >
          <div className="flex items-center gap-3 px-5 py-4 shrink-0 border-b border-slate-200 dark:border-glass-border">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-violet-500/15">
              <Network className="w-5 h-5 text-violet-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 id="export-lineage-title" className="text-[15px] font-display font-bold text-ink leading-tight">
                Export everything it reaches
              </h3>
              <p className="text-[11.5px] text-ink-muted mt-0.5 leading-snug" data-lineage-sentence>{sentence}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-4 overflow-y-auto custom-scrollbar flex flex-col gap-4">
            {phase.kind === 'choose' || phase.kind === 'failed' ? (
              <>
                {adjustable && (
                  <section aria-label="How far" className="grid grid-cols-2 gap-3">
                    <ReachSelect label="Sources (upstream)" value={upstream} onChange={setUpstream} />
                    <ReachSelect label="Consumers (downstream)" value={downstream} onChange={setDownstream} />
                    <label className="col-span-2 inline-flex items-center gap-2 text-[12px] text-ink">
                      <input type="checkbox" checked={inside} onChange={e => setInside(e.target.checked)} />
                      With what is inside those sources and consumers (their columns)
                    </label>
                  </section>
                )}
                <div role="radiogroup" aria-label="Format" className="grid grid-cols-3 gap-1.5">
                  {FORMATS.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      role="radio"
                      aria-checked={format === f.value}
                      onClick={() => setFormat(f.value)}
                      className={cn(
                        'text-left rounded-xl border px-3 py-2 transition-colors',
                        format === f.value
                          ? 'border-accent-lineage/60 bg-accent-lineage/10'
                          : 'border-slate-200 dark:border-glass-border hover:border-accent-lineage/30',
                      )}
                    >
                      <div className="text-[12px] font-semibold text-ink">{f.label}</div>
                      <div className="text-[11px] text-ink-muted leading-snug">{f.description}</div>
                    </button>
                  ))}
                </div>
                <div className="flex flex-col gap-1.5 text-[12px] text-ink">
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={withFlows} onChange={e => setWithFlows(e.target.checked)} data-include-flows />
                    Include the flows between them
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={withDescription} onChange={e => setWithDescription(e.target.checked)} />
                    Description and tags columns
                  </label>
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={withPath} onChange={e => setWithPath(e.target.checked)} data-include-path />
                    Parent and path columns
                  </label>
                  <p className="text-[11px] text-ink-muted">
                    Every row: URN, name, type, qualified name, why it is in (seed, upstream, downstream…), hops{withPath
                      ? ', its nearest starting point, and where it sits — its parent and every container down to it.'
                      : ' and its nearest starting point.'}
                  </p>
                </div>
                {phase.kind === 'failed' && <p role="alert" className="text-[11.5px] text-rose-400">{phase.message}</p>}
              </>
            ) : phase.kind === 'working' ? (
              <Working answer={phase.answer} />
            ) : (
              <Ready answer={phase.answer} />
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3.5 shrink-0 border-t border-slate-200 dark:border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
            {phase.kind === 'working' ? (
              <FooterButton onClick={stop}>Stop</FooterButton>
            ) : phase.kind === 'ready' ? (
              <>
                <FooterButton onClick={onClose}>Done</FooterButton>
                <FooterButton primary onClick={() => { for (const f of phase.files) triggerBrowserDownload(f.url, f.name) }}>
                  <Download className="w-3.5 h-3.5" /> Download again
                </FooterButton>
              </>
            ) : (
              <>
                <FooterButton onClick={onClose}>Cancel</FooterButton>
                <FooterButton primary onClick={start}>
                  <FileDown className="w-3.5 h-3.5" />
                  {phase.kind === 'failed' ? 'Try again' : 'Export'}
                </FooterButton>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </>,
    document.body,
  )
}

function ReachSelect({ label, value, onChange }: { label: string; value: Depth; onChange: (d: Depth) => void }) {
  return (
    <label className="flex flex-col gap-1 text-[11.5px] text-ink-muted">
      {label}
      <select
        value={String(value)}
        onChange={e => onChange(e.target.value === 'all' ? 'all' : Number(e.target.value))}
        className="h-8 px-2 rounded-lg text-[12px] text-ink bg-black/[0.03] dark:bg-white/[0.04] border border-slate-200 dark:border-glass-border"
      >
        {HOPS.map(h => <option key={String(h)} value={String(h)}>{hopsText(h)}</option>)}
      </select>
    </label>
  )
}

function Working({ answer }: { answer: MemberSetStatus | null }) {
  const total = answer?.counts.total ?? 0
  return (
    <div className="flex flex-col gap-2.5 py-2" aria-live="polite">
      <div className="text-[13px] font-semibold text-ink tabular-nums">
        {answer ? STAGE_WORDS[answer.stage] : 'Starting…'} — {total.toLocaleString()} {total === 1 ? 'entity' : 'entities'} so far
      </div>
      <ProgressBar value={answer ? STAGE_PERCENT[answer.stage] : 0} label="Working out everything it reaches" />
      <p className="text-[11px] text-ink-muted">
        {answer && answer.progress.queued > 0 ? `${answer.progress.queued.toLocaleString()} still to follow. ` : ''}
        The server keeps where it got to: stopping, or a busy graph, never loses what it has found.
      </p>
    </div>
  )
}

function Ready({ answer }: { answer: MemberSetStatus }) {
  const notes = truncationNotes(answer)
  return (
    <div className="flex items-start gap-3 py-2" aria-live="polite">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/15">
        <Check className="w-4 h-4 text-emerald-500" />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink tabular-nums" data-lineage-ready>
          {answer.counts.total.toLocaleString()} {answer.counts.total === 1 ? 'entity' : 'entities'} exported
        </div>
        <div className="text-[11.5px] text-ink-muted tabular-nums">
          {answer.counts.seeds.toLocaleString()} starting · {answer.counts.upstream.toLocaleString()} upstream · {answer.counts.downstream.toLocaleString()} downstream
          {answer.missingSeeds > 0 ? ` · ${answer.missingSeeds.toLocaleString()} starting points no longer exist` : ''}
        </div>
        {notes.map(n => <p key={n} className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{n}</p>)}
        <p className="mt-1 text-[11px] text-ink-muted">Your download has started. The link works for an hour.</p>
      </div>
    </div>
  )
}

function FooterButton({ primary, onClick, children }: { primary?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold transition-colors',
        primary
          ? 'bg-accent-lineage text-white hover:brightness-110'
          : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
      )}
    >
      {children}
    </button>
  )
}
