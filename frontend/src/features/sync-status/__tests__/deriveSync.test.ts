import { describe, expect, it } from 'vitest'
import { deriveSync, shortRevision } from '../deriveSync'
import type { SyncStatus } from '../syncStatusApi'

const NOW = Date.parse('2026-09-24T20:36:00Z')
const rev = { commitId: 'cmt_01M3AH4A26Y5ZFJ60G1ZYNM07A', createdAt: '2026-09-24T20:18:52Z', actorName: 'System Admin', message: 'Publish draft' }
const okSummaries = { aggregationStatus: 'ready', driftState: 'managed', lastJobStatus: 'completed', lastSuccessAt: '2026-09-24T20:19:23Z' }
const versioned = (over: Partial<NonNullable<SyncStatus['versioned']>> = {}, summaries: SyncStatus['summaries'] = okSummaries): SyncStatus => ({
  kind: 'versioned', dataSourceId: 'ds', checkedAt: '2026-09-24T20:36:00Z',
  versioned: { graphId: 'g', committed: 11, projected: 11, fresh: true, status: 'idle', committedRevision: rev, projectedRevision: rev, lastProjectedAt: '2026-09-24T20:19:18Z', ...over },
  summaries,
  counts: { nodes: 1922, edges: 2288, readAt: '2026-09-24T20:34:39Z' },
})

describe('deriveSync — a versioned (managed) graph', () => {
  it('is green when the graph holds the published version, and says what kind of graph it is', () => {
    const v = deriveSync(versioned(), NOW)
    expect(v).toMatchObject({ tone: 'ok', chip: 'In sync · v11', headline: 'Everything is in sync', kind: 'versioned', kindLabel: 'Versioned graph' })
    expect(v.lanes.map((l) => l.key)).toEqual(['record', 'graph', 'summaries'])
    expect(v.lanes[0].revision?.commitId).toBe(rev.commitId)
    expect(v.lanes[0].lines[0]).toMatch(/by System Admin$/)
    expect(v.lanes[1].lines.join(' ')).toMatch(/1,922 items · 2,288 connections/)
    expect(v.lanes[2].next).toBe('Updated automatically with every publish')
  })

  it('is amber one version behind, red more than one behind, red when its refresh failed', () => {
    expect(deriveSync(versioned({ projected: 10, fresh: false }), NOW)).toMatchObject({ tone: 'warn', chip: '1 version behind' })
    expect(deriveSync(versioned({ projected: 8, fresh: false }), NOW)).toMatchObject({ tone: 'bad', chip: '3 versions behind' })
    expect(deriveSync(versioned({ projected: 10, fresh: false, lastError: 'boom' }), NOW)).toMatchObject({ tone: 'bad', chip: 'Refresh failed · 1 version behind' })
  })

  it('says it is working, not failing, while it catches up or rebuilds', () => {
    expect(deriveSync(versioned({ projected: 9, fresh: false, status: 'projecting' }), NOW))
      .toMatchObject({ tone: 'busy', busy: true, chip: 'Catching up · 2 versions behind' })
    expect(deriveSync(versioned({ projected: 0, fresh: false, status: 'rebuilding', progressDone: 40, progressTotal: 100 }), NOW).chip)
      .toBe('Rebuilding · 40%')
  })

  it('says the automation is handling the summaries — queued or running — instead of asking for a rebuild', () => {
    const queued = deriveSync(versioned({}, { ...okSummaries, jobId: 'agg_1', jobStatus: 'pending' }), NOW)
    expect(queued).toMatchObject({ tone: 'busy', chip: 'Summaries updating' })
    expect(queued.lanes[2].status).toBe('Queued · starts shortly')
    const running = deriveSync(versioned({}, { ...okSummaries, jobId: 'agg_1', jobStatus: 'running', jobProgress: 42 }), NOW)
    expect(running.lanes[2]).toMatchObject({ tone: 'busy', status: 'Updating now · 42%', progress: 42 })
  })
})

describe('deriveSync — an external graph', () => {
  const external = (source: SyncStatus['source'], summaries: SyncStatus['summaries'], readAt = '2026-09-24T20:35:19Z'): SyncStatus =>
    ({ kind: 'external', dataSourceId: 'ds', checkedAt: '', source, summaries, counts: { nodes: 519594, edges: 1691567, readAt } })

  it('is green only on evidence: counts read recently and unchanged since the last refresh', () => {
    const v = deriveSync(external({ changedSinceRefresh: false, lastReconciledAt: '2026-08-15T20:38:35Z' },
      { aggregationStatus: 'ready', driftState: 'inSync', autoRefresh: true, lastJobStatus: 'completed', lastSuccessAt: '2026-08-15T21:00:00Z' }), NOW)
    expect(v).toMatchObject({ tone: 'ok', kind: 'external', kindLabel: 'External graph', headline: 'In sync with the source' })
    expect(v.lanes[0].status).toBe('No changes since the last refresh')
    expect(v.lanes[0].lines[0]).toMatch(/^519,594 items · 1,691,567 connections · read /)
    expect(v.lanes[1].next).toBe('Rebuilt automatically when the source changes')
  })

  it('never claims "no changes" from a stored verdict — a stale "inSync" with moved counts is a change', () => {
    const v = deriveSync(external({ changedSinceRefresh: true }, { aggregationStatus: 'ready', driftState: 'inSync', autoRefresh: true, lastJobStatus: 'completed' }), NOW)
    expect(v.tone).toBe('warn')
    expect(v.lanes[0].status).toBe('Changed since the last refresh')
    expect(v.lanes[1]).toMatchObject({ status: 'Out of date', next: 'A refresh starts automatically' })
  })

  it('dates a failure and shows the last success beside it (the live Solidatus case)', () => {
    const v = deriveSync(external({ changedSinceRefresh: false },
      { aggregationStatus: 'failed', driftState: 'inSync', autoRefresh: true, lastJobStatus: 'cancelled', lastJobAt: '2026-08-16T00:54:07Z', lastSuccessAt: '2026-07-21T14:15:05Z' }), NOW)
    expect(v).toMatchObject({ tone: 'warn', chip: 'Summaries: rebuild cancelled' })
    expect(v.lanes[1].status).toMatch(/^Last rebuild was cancelled .+ ago$/)
    expect(v.lanes[1].lines).toContain(`Showing summaries built ${v.lanes[1].lines.at(-1)!.replace('Showing summaries built ', '')}`)
    expect(v.lanes[1].next).toBe('Retried automatically when the source next changes')
  })

  it('does not promise automation that an operator hold has stopped', () => {
    const v = deriveSync(external({ changedSinceRefresh: true },
      { aggregationStatus: 'ready', driftState: 'drifting', autoRefresh: true, heldKind: 'stopped', heldBy: 'fleet', lastJobStatus: 'completed' }), NOW)
    expect(v.lanes[1].next).toBe('Automatic rebuilds are stopped for all sources')
  })

  it('is amber when counts have not been read for over an hour, red when summaries are not served', () => {
    expect(deriveSync(external({ changedSinceRefresh: false }, { aggregationStatus: 'ready', driftState: 'inSync' }, '2026-09-24T18:00:00Z'), NOW).tone).toBe('warn')
    expect(deriveSync(external({ changedSinceRefresh: false }, { aggregationStatus: 'ready', driftState: 'projectionStalled' }), NOW).tone).toBe('bad')
  })
})

it('shortens a revision id for display', () => {
  expect(shortRevision(rev.commitId)).toBe('cmt_01M3AH4A…')
  expect(shortRevision('cmt_1')).toBe('cmt_1')
})
