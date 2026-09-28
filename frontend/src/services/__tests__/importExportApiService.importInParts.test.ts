/**
 * importInParts pins: every part of the file goes up (the last holds the rest), then the import
 * starts from them; the same file chosen again after a failure resumes, sending only the parts the
 * server doesn't hold; a part the server failed on is sent again, one it refused is not; a finished
 * upload is forgotten, so the same file imports afresh next time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../apiClient', () => ({ authFetch: vi.fn() }))
vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { authFetch } from '../apiClient'
import { fetchWithTimeout } from '../fetchWithTimeout'
import { importInParts, type ImportUpload } from '../importExportApiService'

const FILE = new File(['0123456789'], 'graph.ndjson', { lastModified: 1 })   // 10 bytes: parts of 4, 4, 2
const CREATED = { jobId: 'j1', branchId: 'b1', sourceUri: 's', status: 'pending' as const }

function upload(over: Partial<ImportUpload> = {}): ImportUpload {
  return { uploadId: 'iu_1', fileName: 'graph.ndjson', size: 10, format: 'ndjson', partBytes: 4, parts: 3,
    received: [], jobId: null, ...over }
}

function server(existing?: ImportUpload) {
  vi.mocked(authFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/imports/uploads')) return upload()
    if (url.includes('/complete')) return CREATED
    if (existing && url.endsWith(`/uploads/${existing.uploadId}`)) return existing
    throw new Error('This upload has expired.')
  })
}

const sentParts = () => vi.mocked(fetchWithTimeout).mock.calls
  .map(([url, init]) => [String(url).split('/parts/')[1], (init?.body as Blob).size] as const)
  .sort()

beforeEach(() => {
  localStorage.clear()
  vi.mocked(authFetch).mockReset()
  vi.mocked(fetchWithTimeout).mockReset()
})

describe('importInParts', () => {
  it('sends every part, then starts the import from them', async () => {
    server()
    vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response(null, { status: 200 }))
    const progress: number[] = []

    const created = await importInParts('ws1', 'g1', FILE, {
      format: 'ndjson', reconcileMode: 'replace', branchId: 'br_9', onProgress: (sent) => progress.push(sent),
    })

    expect(created).toEqual(CREATED)
    expect(sentParts()).toEqual([['0', 4], ['1', 4], ['2', 2]])
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(10)
    const complete = vi.mocked(authFetch).mock.calls.find(([url]) => String(url).includes('/complete'))!
    expect(complete[0]).toContain('/uploads/iu_1/complete?reconcileMode=replace&branchId=br_9')
    expect(localStorage.length).toBe(0)
  })

  it('resumes an upload of the same file, sending only what the server lacks', async () => {
    server()
    vi.mocked(fetchWithTimeout).mockImplementation(async (url) =>
      new Response(JSON.stringify({ detail: 'Part 1 should hold 4 bytes.' }),
        { status: String(url).endsWith('/parts/1') ? 422 : 200 }))
    await expect(importInParts('ws1', 'g1', FILE, { format: 'ndjson' })).rejects.toThrow('Part 1 should hold 4 bytes.')
    expect(localStorage.length).toBe(1)

    vi.mocked(fetchWithTimeout).mockClear()
    vi.mocked(authFetch).mockClear()
    server(upload({ received: [0, 2] }))
    vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response(null, { status: 200 }))
    const progress: number[] = []
    await importInParts('ws1', 'g1', FILE, { format: 'ndjson', onProgress: (sent) => progress.push(sent) })

    expect(sentParts()).toEqual([['1', 4]])
    expect(progress[0]).toBe(6)
    expect(vi.mocked(authFetch).mock.calls.some(([url, init]) => init?.method === 'POST' && String(url).endsWith('/uploads')))
      .toBe(false)
  })

  it('sends again a part the server failed on', async () => {
    server()
    let failures = 1
    vi.mocked(fetchWithTimeout).mockImplementation(async (url) =>
      new Response(null, { status: String(url).endsWith('/parts/2') && failures-- > 0 ? 503 : 200 }))

    await importInParts('ws1', 'g1', FILE, { format: 'ndjson' })
    expect(sentParts()).toEqual([['0', 4], ['1', 4], ['2', 2], ['2', 2]])
  })

  it('starts afresh when the remembered upload was already imported', async () => {
    localStorage.setItem('import-upload:ws1:g1:graph.ndjson:10:1:ndjson', 'iu_old')
    server(upload({ uploadId: 'iu_old', received: [0, 1, 2], jobId: 'j0' }))
    vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response(null, { status: 200 }))

    await importInParts('ws1', 'g1', FILE, { format: 'ndjson' })
    expect(sentParts()).toHaveLength(3)
  })
})
