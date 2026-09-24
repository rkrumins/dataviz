/**
 * ONE reading of a view's sync status, shared by the header chip, its hover and its card, so the
 * three can never disagree. Pure: the same document and clock always give the same verdict.
 *
 * Two kinds of graph, said plainly because they sync differently:
 *  - VERSIONED (managed here): changes are published through review into the system of record
 *    (Postgres), then written to the graph (FalkorDB). Graph holds the published version → green;
 *    one version behind → amber; more than one, or its last refresh failed → red; catching up or
 *    rebuilding → "working", with how far it has to go.
 *  - EXTERNAL (read from its own FalkorDB): this app never edits it. It reads the graph's counts,
 *    notices when they move, and rebuilds its lineage summaries. Counts read recently and nothing
 *    changed since the last refresh → green; a change waiting, counts not read for a while, or a
 *    failed summaries rebuild → amber; summaries not served at all → red.
 *
 * Accuracy rules: every claim is dated with the evidence behind it. "No changes" comes from a live
 * comparison of the latest counts with the last refresh's baseline, never from a stored verdict
 * (which survives skipped evaluations); a failure is shown with WHEN it happened, beside the last
 * success; and "what happens next" says only what the automation will actually do.
 */
import { timeAgo } from '@/lib/timeAgo'
import type { SyncRevision, SyncStatus, SyncSummaries } from './syncStatusApi'

export type SyncTone = 'ok' | 'warn' | 'bad' | 'busy' | 'idle'

export interface SyncLane {
  key: 'record' | 'graph' | 'source' | 'summaries'
  title: string
  /** The technology, for readers who know it (quiet, secondary). */
  tech: string
  tone: SyncTone
  /** The lane's state in a few words. */
  status: string
  /** An even shorter form for the header chip ("rebuild failed"). */
  short?: string
  /** Supporting facts, one per line. */
  lines: string[]
  /** What the automation will do next, when that is worth saying. */
  next?: string
  version?: number
  revision?: SyncRevision | null
  /** 0–100 while something is running with measurable progress. */
  progress?: number | null
}

export interface SyncVerdict {
  kind: SyncStatus['kind'] | null
  /** "Versioned graph" / "External graph". */
  kindLabel: string
  /** One sentence on how this kind of graph stays in sync. */
  kindExplainer: string
  tone: SyncTone
  /** The chip's own words — short. */
  chip: string
  headline: string
  detail: string
  lanes: SyncLane[]
  /** Something is moving right now — poll faster, animate the rail. */
  busy: boolean
}

const RANK: Record<SyncTone, number> = { idle: 0, ok: 1, busy: 2, warn: 3, bad: 4 }
const worst = (tones: SyncTone[]): SyncTone => {
  const real = tones.filter((t) => t !== 'idle')
  return real.length === 0 ? 'idle' : real.reduce((a, b) => (RANK[b] > RANK[a] ? b : a))
}
const versions = (n: number) => `${n} version${n === 1 ? '' : 's'}`
const ago = (iso?: string | null) => (iso ? timeAgo(iso) : '')
const num = (n: number) => n.toLocaleString()
/** Counts older than this are "not read recently" (the stats service normally reads every few minutes). */
const READ_STALE_MS = 60 * 60 * 1000

export const KIND_TEXT = {
  versioned: {
    label: 'Versioned graph',
    explainer: 'Managed here: changes are published through review into the system of record, then written to the graph.',
  },
  external: {
    label: 'External graph',
    explainer: 'Read from its own FalkorDB — never edited here. This app watches it for changes and keeps its lineage summaries current.',
  },
} as const

export function shortRevision(id?: string | null): string {
  if (!id) return ''
  return id.length > 14 ? `${id.slice(0, 12)}…` : id
}

function summariesLane(s: SyncSummaries | null | undefined, doc: SyncStatus, now: number): SyncLane {
  const lane: SyncLane = { key: 'summaries', title: 'Lineage summaries', tech: 'Rollups', tone: 'idle', status: 'Not reported', lines: [] }
  if (!s) return lane
  const versioned = doc.kind === 'versioned'
  const changed = doc.source?.changedSinceRefresh
  const future = (iso?: string | null) => !!iso && new Date(iso).getTime() > now
  const built = s.lastSuccessAt ? `Last built ${ago(s.lastSuccessAt)}` : 'Never built successfully'
  // What the automation will actually do next — no promises it doesn't keep. A hold (all sources,
  // this provider, or this source; stopped or paused) means it evaluates but does not act.
  const scope = s.heldBy === 'fleet' ? 'for all sources' : s.heldBy === 'provider' ? 'for this provider' : 'for this source'
  const held = s.heldKind
    ? `Automatic rebuilds are ${s.heldKind === 'stopped' ? 'stopped' : 'paused'} ${scope}${s.heldKind === 'paused' && s.heldUntil ? ` until ${new Date(s.heldUntil).toLocaleString()}` : ''}`
    : null
  const next = versioned
    ? 'Updated automatically with every publish'
    : held ?? (s.autoRefresh === false ? 'Automatic refresh is off — rebuild from Data sources'
    : changed ? (future(s.cooldownUntil) ? `A refresh is scheduled ${new Date(s.cooldownUntil!).toLocaleTimeString()}` : 'A refresh starts automatically')
    : 'Rebuilt automatically when the source changes')

  if (s.jobStatus === 'running') {
    return { ...lane, tone: 'busy', short: 'updating', status: s.jobProgress != null ? `Updating now · ${s.jobProgress}%` : 'Updating now',
      progress: s.jobProgress ?? null, lines: [s.jobStartedAt ? `Started ${ago(s.jobStartedAt)}` : built] }
  }
  if (s.jobStatus === 'pending' || (s.jobId && !s.jobStatus)) {
    return { ...lane, tone: 'busy', short: 'queued', status: 'Queued · starts shortly', lines: [built] }
  }
  if (s.driftState === 'projectionStalled') {
    return { ...lane, tone: 'bad', short: 'missing', status: 'Not being served', lines: ['The graph is behind, so lineage summaries are missing until it catches up', built] }
  }
  if (future(s.pausedUntil)) {
    return { ...lane, tone: 'warn', short: 'paused', status: `Paused until ${new Date(s.pausedUntil!).toLocaleString()}`, lines: [built] }
  }
  // The newest attempt did not finish: say what happened and WHEN, beside the last success.
  if (s.lastJobStatus === 'failed' || s.lastJobStatus === 'cancelled' || s.aggregationStatus === 'failed') {
    const what = s.lastJobStatus === 'cancelled' ? 'was cancelled' : 'failed'
    return { ...lane, tone: 'warn', short: s.lastJobStatus === 'cancelled' ? 'rebuild cancelled' : 'rebuild failed', status: `Last rebuild ${what}${s.lastJobAt ? ` ${ago(s.lastJobAt)}` : ''}`,
      lines: [
        ...(s.lastFailureReason ? [s.lastFailureReason] : []),
        s.lastSuccessAt ? `Showing summaries built ${ago(s.lastSuccessAt)}` : 'No earlier summaries to show',
      ],
      next: versioned ? 'A manager can rebuild them from Data health'
        : held ? held
        : s.autoRefresh === false ? 'Automatic refresh is off — rebuild from Data sources'
        : changed ? 'Retried automatically now that the source has changed'
        : 'Retried automatically when the source next changes' }
  }
  if (s.driftState === 'neverBuilt' || s.aggregationStatus === 'none') {
    return { ...lane, tone: 'warn', short: 'not built', status: 'Not built yet', lines: [], next }
  }
  if (!versioned && changed) {
    return { ...lane, tone: 'warn', short: 'out of date', status: 'Out of date', lines: [built], next }
  }
  return { ...lane, tone: 'ok', short: 'up to date', status: 'Up to date', lines: [built], next }
}

export function deriveSync(doc: SyncStatus | undefined, now: number = Date.now()): SyncVerdict {
  if (!doc) {
    return { kind: null, kindLabel: '', kindExplainer: '', tone: 'idle', chip: 'Checking sync…',
      headline: 'Checking sync…', detail: '', lanes: [], busy: false }
  }
  const summaries = summariesLane(doc.summaries, doc, now)
  const counts = doc.counts
  const countLine = counts ? `${num(counts.nodes)} items · ${num(counts.edges)} connections` : null

  if (doc.kind === 'versioned' && doc.versioned) {
    const v = doc.versioned
    const behind = Math.max(0, v.committed - v.projected)
    const active = v.status === 'projecting' || v.status === 'rebuilding'
    const pct = v.progressTotal ? Math.round(((v.progressDone ?? 0) / v.progressTotal) * 100) : null
    const record: SyncLane = {
      key: 'record', title: 'System of record', tech: 'Postgres', version: v.committed,
      tone: v.committed > 0 ? 'ok' : 'idle',
      status: v.committed > 0 ? `Version #${v.committed} saved` : 'Nothing published yet',
      revision: v.committedRevision,
      lines: v.committedRevision
        ? [`Published ${ago(v.committedRevision.createdAt)}${v.committedRevision.actorName ? ` by ${v.committedRevision.actorName}` : ''}`]
        : [],
    }
    const graphTone: SyncTone = v.lastError && !v.fresh ? 'bad'
      : active ? 'busy'
      : v.fresh ? 'ok'
      : behind <= 1 ? 'warn' : 'bad'
    const graph: SyncLane = {
      key: 'graph', title: 'Graph', tech: 'FalkorDB', version: v.projected, tone: graphTone,
      revision: v.projectedRevision, progress: v.status === 'rebuilding' ? pct : null,
      status: graphTone === 'ok' ? `Version #${v.projected} · in sync`
        : v.status === 'rebuilding' ? (pct != null ? `Rebuilding · ${pct}%` : 'Rebuilding…')
        : active ? `Catching up · ${versions(behind)} behind`
        : v.lastError ? `Refresh failed · ${versions(behind)} behind`
        : `${versions(behind)} behind`,
      lines: [
        v.lastProjectedAt ? `Written ${ago(v.lastProjectedAt)}` : 'Not written yet',
        ...(countLine ? [`${countLine}${counts?.readAt ? ` · counted ${ago(counts.readAt)}` : ''}`] : []),
        ...(v.lastError && !v.fresh ? ['Views read from the system of record until it catches up'] : []),
      ],
      next: graphTone === 'ok' ? 'Written automatically after every publish'
        : active ? undefined
        : v.lastError ? 'A manager can rebuild it from Data health'
        : 'Catches up automatically',
    }
    const lanes = [record, graph, summaries]
    const tone = worst([graph.tone, summaries.tone])
    const busy = graph.tone === 'busy' || summaries.tone === 'busy'
    const chip = graph.tone === 'ok'
      ? summaries.tone === 'busy' ? 'Summaries updating'
        : summaries.tone === 'warn' || summaries.tone === 'bad' ? 'Summaries need attention'
        : `In sync · v${v.committed}`
      : graph.status
    const headline = graph.tone === 'ok'
      ? summaries.tone === 'ok' || summaries.tone === 'idle' ? 'Everything is in sync' : 'The graph is in sync'
      : graph.tone === 'busy' ? 'Catching up' : 'The graph is behind'
    const detail = graph.tone === 'ok'
      ? `Published version #${v.committed} is in the graph${summaries.tone === 'ok' || summaries.tone === 'idle' ? '' : ` · summaries: ${summaries.status.toLowerCase()}`}`
      : `The system of record is at #${v.committed}; the graph holds #${v.projected}`
    return { kind: 'versioned', kindLabel: KIND_TEXT.versioned.label, kindExplainer: KIND_TEXT.versioned.explainer,
      tone, chip, headline, detail, lanes, busy }
  }

  // External: judged on evidence read from the graph, not on stored verdicts.
  const src = doc.source
  const readAt = counts?.readAt ? new Date(counts.readAt).getTime() : null
  const readStale = readAt != null && now - readAt > READ_STALE_MS
  const changed = src?.changedSinceRefresh
  const sourceTone: SyncTone = readAt == null ? 'idle'
    : readStale ? 'warn'
    : changed ? 'warn'
    : changed === false ? 'ok'
    : 'idle'
  const source: SyncLane = {
    key: 'source', title: 'Source graph', tech: 'FalkorDB', tone: sourceTone,
    status: readAt == null ? 'Not read yet'
      : readStale ? `Not read for ${ago(counts!.readAt).replace(/ ago$/, '')}`
      : changed ? 'Changed since the last refresh'
      : changed === false ? 'No changes since the last refresh'
      : 'Not compared yet',
    lines: [
      ...(countLine ? [`${countLine}${counts?.readAt ? ` · read ${ago(counts.readAt)}` : ''}`] : []),
      src?.lastReconciledAt ? `Last refreshed ${ago(src.lastReconciledAt)}` : 'Never refreshed automatically',
    ],
    next: readStale ? 'Counts are read automatically — they have not arrived recently' : undefined,
  }
  const lanes = [source, summaries]
  const tone = worst([source.tone, summaries.tone])
  const busy = summaries.tone === 'busy'
  const chip = tone === 'ok' ? `In sync · read ${ago(counts?.readAt)}`
    : summaries.tone === 'busy' ? 'Refreshing'
    : summaries.tone === 'bad' ? 'Summaries missing'
    : source.tone === 'warn' ? source.status
    : summaries.tone === 'warn' ? `Summaries: ${summaries.short ?? 'need attention'}`
    : 'Sync not reported yet'
  const headline = tone === 'ok' ? 'In sync with the source'
    : busy ? 'Catching up with the source'
    : tone === 'idle' ? 'Sync not reported yet' : 'Needs attention'
  const detail = [source.lines[0], summaries.tone !== 'ok' && summaries.tone !== 'idle' ? `Summaries: ${summaries.status.toLowerCase()}` : '']
    .filter(Boolean).join(' · ')
  return { kind: 'external', kindLabel: KIND_TEXT.external.label, kindExplainer: KIND_TEXT.external.explainer,
    tone, chip, headline, detail, lanes, busy }
}
