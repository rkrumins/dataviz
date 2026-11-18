/**
 * Everything it reaches — the server works it out, the dialog follows it and
 * downloads it. The trace's question is said, not changed; a search's matches
 * take the reach the reader picks; flows come as a file of their own.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemberSetRequest, MemberSetStatus } from '@/types/memberSet'

const downloads: Array<{ url: string; name: string }> = []
vi.mock('@/services/importExportApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/importExportApiService')>()),
  triggerBrowserDownload: (url: string, name: string) => downloads.push({ url, name }),
}))

let current: unknown = null
vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => current }))

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { ExportLineageDialog } from '../ExportLineageDialog'

const done = (over: Partial<MemberSetStatus> = {}): MemberSetStatus => ({
  setId: 'ms_1', specHash: 'h', status: 'complete', stage: 'done',
  counts: { seeds: 2, inside: 0, upstream: 40_000, downstream: 12_000, partnerInside: 0, total: 52_002 },
  missingSeeds: 0, truncated: [], dataVersion: '1', progress: { steps: 30, queued: 0 },
  startedAt: '', expiresAt: '', downloadToken: 'tok', ...over,
})

let bodies: MemberSetRequest[] = []
function provider(answers: MemberSetStatus[]) {
  const p = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
  p.memberSet = vi.fn(async (_v: string | null, body: MemberSetRequest) => { bodies.push(body); return answers.shift() ?? done() })
  p.memberSetDownloadUrl = (setId, token, format, part = 'nodes') => `/dl/${setId}?token=${token}&format=${format}&part=${part}`
  return p
}

const TRACE_SPEC = {
  v: 1 as const, seeds: { urns: ['a', 'b'] }, within: 'view' as const,
  expand: { children: 0, upstream: 'all' as const, downstream: 3, partnerChildren: 0 },
}

const mount = (p: RemoteGraphProvider, props: Partial<React.ComponentProps<typeof ExportLineageDialog>> = {}) => {
  current = p
  return render(<ExportLineageDialog viewId="v1" spec={TRACE_SPEC} seedsLabel="2 entities" onClose={() => {}} {...props} />)
}

beforeEach(() => { bodies = []; downloads.length = 0 })
afterEach(() => vi.restoreAllMocks())

describe('ExportLineageDialog', () => {
  it('says the trace’s question, follows the set, and downloads the entities and the flows', async () => {
    mount(provider([done({ status: 'running', stage: 'upstream', downloadToken: null }), done()]))
    expect(document.querySelector('[data-lineage-sentence]')?.textContent).toMatch(/2 entities/)
    fireEvent.click(document.querySelector('[data-include-flows]')!)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    await waitFor(() => expect(document.querySelector('[data-lineage-ready]')?.textContent).toMatch(/52,002 entities exported/))
    expect(bodies[0]).toMatchObject({ spec: TRACE_SPEC, includeEdges: true })
    expect(bodies[1]).toMatchObject({ setId: 'ms_1' })
    expect(downloads.map(d => d.url)).toEqual(['/dl/ms_1?token=tok&format=csv&part=nodes', '/dl/ms_1?token=tok&format=csv&part=edges'])
    expect(downloads[1]!.name).toMatch(/-flows\.csv$/)
  })

  it('JSON is one document, flows and all', async () => {
    mount(provider([done()]))
    fireEvent.click(screen.getByRole('radio', { name: /^JSON/ }))
    fireEvent.click(document.querySelector('[data-include-flows]')!)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]!.url).toContain('format=json')
  })

  it('a search’s matches take the reach the reader picks', async () => {
    mount(provider([done()]), {
      spec: { v: 1, seeds: { query: { kind: 'all' } as never }, within: 'dataSource', expand: { children: 0, upstream: 0, downstream: 0, partnerChildren: 0 } },
      seedsLabel: 'the matches of your search',
      adjustable: true,
    })
    fireEvent.change(screen.getByLabelText(/Sources \(upstream\)/), { target: { value: 'all' } })
    fireEvent.click(screen.getByLabelText(/With what is inside those/))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]!.spec).toMatchObject({ within: 'dataSource', expand: { upstream: 'all', downstream: 1, partnerChildren: 1 } })
  })

  it('every limit the server reached is said', async () => {
    mount(provider([done({ truncated: [{ reason: 'member_cap', seen: 1_000_001, limit: 1_000_000 }] })]))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    await waitFor(() => expect(screen.getByText(/more than 1,000,000 entities/)).toBeTruthy())
  })
})
