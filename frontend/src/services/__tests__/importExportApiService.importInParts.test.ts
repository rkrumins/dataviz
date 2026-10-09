/**
 * importInParts pins: every part of the file goes up (the last holds the rest), then the import
 * starts from them; the same file chosen again after a failure resumes, sending only the parts the
 * server doesn't hold; a part the server failed on is sent again, one it refused is not; a finished
 * upload is forgotten, so the same file imports afresh next time; parts the server sends straight
 * to its object store (`partUrls`) go there without this site's cookies — through the server
 * instead once the browser can't send one there, and again under fresh URLs once one has expired.
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

  it('sends parts straight to the URLs the server hands out, as bare requests: no cookies, no CSRF header', async () => {
    const urls = ['https://store.example/p0?sig=a', 'https://store.example/p1?sig=b', 'https://store.example/p2?sig=c']
    vi.mocked(authFetch).mockImplementation(async (url: string) =>
      (url.includes('/complete') ? CREATED : upload({ partUrls: urls })))
    let failures = 1
    const bare = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: String(url) === urls[1] && failures-- > 0 ? 503 : 200 }))
    vi.stubGlobal('fetch', bare)
    try {
      await importInParts('ws1', 'g1', FILE, { format: 'ndjson' })
    } finally {
      vi.unstubAllGlobals()
    }

    expect(fetchWithTimeout).not.toHaveBeenCalled()
    const puts = bare.mock.calls.map(([url, init]) => [String(url), init?.method, init?.credentials, init?.headers])
    expect(puts.sort()).toEqual([urls[0], urls[1], urls[1], urls[2]].map((url) => [url, 'PUT', 'omit', undefined]))
  })

  describe('when a presigned URL fails', () => {
    const urls = ['https://store.example/p0?sig=a', 'https://store.example/p1?sig=b', 'https://store.example/p2?sig=c']
    const withBareFetch = async (bare: (url: string) => Promise<Response>, run: () => Promise<unknown>) => {
      const spy = vi.fn(async (url: RequestInfo | URL) => bare(String(url)))
      vi.stubGlobal('fetch', spy)
      try {
        await run()
      } finally {
        vi.unstubAllGlobals()
      }
      return spy.mock.calls.map(([url]) => String(url))
    }

    it('sends the parts through the server once the browser can’t send one there (CSP, CORS): no five tries', async () => {
      vi.mocked(authFetch).mockImplementation(async (url: string) =>
        (url.includes('/complete') ? CREATED : upload({ partUrls: urls })))
      vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response(null, { status: 200 }))

      const direct = await withBareFetch(async () => { throw new TypeError('Failed to fetch') },
        () => importInParts('ws1', 'g1', FILE, { format: 'ndjson' }))
      expect(direct).toHaveLength(3)                               // each part once, the three under way
      expect(sentParts()).toEqual([['0', 4], ['1', 4], ['2', 2]])
    })

    it('reads the upload again for freshly signed URLs when one has expired (403), and sends the part again', async () => {
      const fresh = urls.map((u) => u.replace('sig=', 'sig=new-'))
      let reads = 0
      vi.mocked(authFetch).mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/complete')) return CREATED
        if (init?.method === 'POST') return upload({ partUrls: urls })
        reads += 1
        return upload({ partUrls: fresh })
      })

      const direct = await withBareFetch(async (url) => new Response(
        url.includes('sig=new-') ? null : '<Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message></Error>',
        { status: url.includes('sig=new-') ? 200 : 403 }),
      () => importInParts('ws1', 'g1', FILE, { format: 'ndjson' }))
      expect(reads).toBe(1)
      expect(direct.filter((u) => u.includes('sig=new-')).sort()).toEqual(fresh)
      expect(fetchWithTimeout).not.toHaveBeenCalled()
    })

    it('says what the store said when it refuses a part, in words', async () => {
      vi.mocked(authFetch).mockImplementation(async () => upload({ partUrls: urls }))
      await expect(withBareFetch(async () => new Response(
        '<Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>',
        { status: 400 }), () => importInParts('ws1', 'g1', FILE, { format: 'ndjson' })))
        .rejects.toThrow('The file store refused part of the file: Your proposed upload exceeds the maximum allowed size')
    })

    it('sends nothing more once cancelled between two parts', async () => {
      vi.mocked(authFetch).mockImplementation(async () => upload({ partUrls: urls }))
      const cancel = new AbortController()
      const direct = await withBareFetch(async () => {
        cancel.abort()
        return new Response(null, { status: 200 })
      }, () => expect(importInParts('ws1', 'g1', FILE, { format: 'ndjson', signal: cancel.signal })).rejects.toThrow())
      expect(direct).toHaveLength(1)                               // the part that was under way
    })
  })

  it('sends parts through the server with this site’s cookies', async () => {
    server()
    vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response(null, { status: 200 }))

    await importInParts('ws1', 'g1', FILE, { format: 'ndjson' })
    expect(vi.mocked(fetchWithTimeout).mock.calls.every(([, init]) => init?.credentials === undefined)).toBe(true)
  })

  it('starts afresh when the remembered upload was already imported', async () => {
    localStorage.setItem('import-upload:ws1:g1:graph.ndjson:10:1:ndjson', 'iu_old')
    server(upload({ uploadId: 'iu_old', received: [0, 1, 2], jobId: 'j0' }))
    vi.mocked(fetchWithTimeout).mockImplementation(async () => new Response(null, { status: 200 }))

    await importInParts('ws1', 'g1', FILE, { format: 'ndjson' })
    expect(sentParts()).toHaveLength(3)
  })
})
