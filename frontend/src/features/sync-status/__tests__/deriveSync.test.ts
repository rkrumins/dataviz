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

  it('says views show an earlier version, which and until when, while the graph is written to a newer one', () => {
    const older = { commitId: 'cmt_older', createdAt: '2026-09-24T20:06:00Z' }
    const v = deriveSync(versioned({ projected: 9, fresh: false, status: 'projecting', served: 9, servedRevision: older }), NOW)
    expect(v).toMatchObject({ tone: 'busy', showingOlder: true, chip: 'Showing #9 · writing #11',
      headline: 'Showing an earlier version while the graph updates' })
    expect(v.detail).toMatch(/^Views show version #9, published .+ ago, until version #11 is written to the graph, then refresh on their own$/)
    expect(v.lanes[1]).toMatchObject({ version: 9, revision: older })
    expect(v.lanes[1].lines[0]).toBe('Views show version #9 until version #11 is written, then refresh on their own')
    expect(v.lanes[1].lines.join(' ')).not.toMatch(/system of record/)
    // A rebuild resets the watermark, not what views show; a failed pass still shows it, in red.
    expect(deriveSync(versioned({ projected: 0, fresh: false, status: 'rebuilding', served: 9, progressDone: 45, progressTotal: 100 }), NOW))
      .toMatchObject({ showingOlder: true, chip: 'Showing #9 · rebuilding 45%' })
    expect(deriveSync(versioned({ projected: 9, fresh: false, served: 9, lastError: 'Query timed out' }), NOW))
      .toMatchObject({ tone: 'bad', showingOlder: true, chip: 'Showing #9 · refresh failed' })
  })

  it('says views read the system of record only when the graph has no version to show', () => {
    const v = deriveSync(versioned({ projected: 0, fresh: false, status: 'rebuilding', served: null }), NOW)
    expect(v).toMatchObject({ showingOlder: false, chip: 'Rebuilding…', headline: 'Catching up' })
    expect(v.lanes[1].lines).toContain('Views read from the system of record until it catches up')
    // An older server, which does not say what views show: as before.
    expect(deriveSync(versioned({ projected: 9, fresh: false, status: 'projecting' }), NOW))
      .toMatchObject({ showingOlder: false, chip: 'Catching up · 2 versions behind' })
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

describe('deriveSync — what readers get while a newer version lands', () => {
  it('says a graph read "always the latest" shows the newest version from the system of record, by choice', () => {
    const v = deriveSync(versioned({ projected: 9, fresh: false, status: 'projecting', served: null, readMode: 'latest' }), NOW)
    expect(v).toMatchObject({ tone: 'busy', chip: 'Latest #11 · read from the database',
      headline: 'Showing the newest version from the system of record while the graph updates' })
    const graph = v.lanes[1]
    expect(graph.lines.join(' ')).toMatch(/always shows the newest version/)
    expect(graph.lines.join(' ')).not.toMatch(/until it catches up/)
  })

  it('says, updating in place, that parts of the new version can show before the rest', () => {
    const v = deriveSync(versioned({ projected: 9, fresh: false, status: 'projecting', served: 9, readMode: 'in_place' }), NOW)
    expect(v.chip).toBe('Showing #9 · writing #11')
    expect(v.lanes[1].lines.join(' ')).toMatch(/Parts of version #11 can show before the rest of it is written/)
    const beside = deriveSync(versioned({ projected: 9, fresh: false, status: 'projecting', served: 9, readMode: 'beside' }), NOW)
    expect(beside.lanes[1].lines.join(' ')).not.toMatch(/Parts of version/)
  })

  it('says, switching when ready, that views show exactly one version while the next is built beside it', () => {
    const building = (candidate: NonNullable<NonNullable<SyncStatus['versioned']>['candidate']>) =>
      deriveSync(versioned({ projected: 9, fresh: false, status: 'idle', served: 9, readMode: 'beside', candidate }), NOW)
    const v = building({ step: 'catching_up', seq: 10, attempts: 0 })
    expect(v).toMatchObject({ tone: 'busy', chip: 'Showing #9 · building #11',
      headline: 'Building the new version beside the one views show' })
    expect(v.lanes[1].lines.join(' ')).toMatch(/exactly version #9 while version #11 is built beside it and checked, then all switch to it at once/)
    expect(v.detail).toMatch(/until version #11 is built and checked beside it, then switch to it at once/)
    expect(building({ step: 'copying' }).chip).toBe('Showing #9 · copying to build #11')
    expect(building({ step: 'switching', seq: 11 }).chip).toBe('Showing #9 · switching to #11')
    const waiting = building({ step: 'queued', waiting: 'no room for a copy on its node (capacity)' })
    expect(waiting.chip).toBe('Showing #9 · waiting to build #11')
    expect(waiting.lanes[1].lines.join(' ')).toMatch(/Waiting: no room for a copy/)
    const failed = building({ step: 'copying', attempts: 1, error: 'the node went away mid-copy' })
    expect(failed.tone).toBe('warn')
    expect(failed.lanes[1].lines.join(' ')).toMatch(/Attempt 1 failed: the node went away mid-copy · trying again/)
  })
})
