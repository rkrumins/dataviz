/**
 * A view package's way in and out, at the service's boundary (the server stood in for at
 * `fetchWithTimeout`). Pins:
 *   - reading a package: it goes up in parts, the server's job checks it (followed until it is
 *     ready), then it is described; how much is up, then how far the check has got, is heard;
 *   - the same file chosen again (a reopened wizard) resumes its upload, sending only the parts the
 *     server lacks, or reads the package already checked without sending or checking it again; an
 *     upload about to expire is not resumed, the file goes up afresh;
 *   - a file that is no package to import says why, with the server's code;
 *   - exporting one: the request carries its id, and answers with the export job that builds it
 *     (followed, and downloaded, as any export the server prepares: backgroundExports).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))
// The check is followed like every job (pollJob); its waits shortened so the tests don't sit them out.
vi.mock('@/config/polling', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config/polling')>(),
  jobPollDelayMs: () => 1,
}))

import { fetchWithTimeout } from '../fetchWithTimeout'
import {
  inspectViewPackage, startViewPackage, ViewTransferError,
  type PackageProgress, type PackageUpload,
} from '../viewTransferApiService'

const FILE = new File(['0123456789'], 'finance.view-package.zip', { lastModified: 1 })   // 10 bytes: parts of 4, 4, 2
const KEY = 'view-package-upload:finance.view-package.zip:10:1'
const UPLOADS = '/api/v1/views/transfer/packages/uploads'
const LATER = () => new Date(Date.now() + 20 * 3600_000).toISOString()

function upload(over: Partial<PackageUpload> = {}): PackageUpload {
  return { uploadId: 'up_1', fileName: FILE.name, size: 10, partBytes: 4, parts: 3, received: [], status: 'uploading',
    expiresAt: LATER(), ...over }
}

const INSPECTED = { uploadId: 'up_1', views: [], package: { scope: 'view', data: null, parts: {}, integrity: 'verified' } }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The server: `routes` answers `METHOD path` (in turn, when a list); everything is recorded. */
function serve(routes: Record<string, Response | (() => Response) | Array<() => Response>>) {
  vi.mocked(fetchWithTimeout).mockImplementation(async (input, init) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url.includes('/parts/') ? url.replace(/\/parts\/\d+$/, '/parts/n') : url}`
    const route = routes[key]
    if (!route) throw new Error(`unexpected ${key}`)
    const answer = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]) : route
    return typeof answer === 'function' ? answer() : answer.clone()
  })
}

const calls = () => vi.mocked(fetchWithTimeout).mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`)
const sentParts = () => vi.mocked(fetchWithTimeout).mock.calls
  .filter(([input]) => String(input).includes('/parts/'))
  .map(([input, init]) => [String(input).split('/parts/')[1], (init?.body as Blob).size] as const)
  .sort()

beforeEach(() => {
  localStorage.clear()
  vi.mocked(fetchWithTimeout).mockReset()
})

describe('inspectViewPackage', () => {
  it('sends the package in parts, has the server check it, then reads it', async () => {
    serve({
      [`POST ${UPLOADS}`]: () => json(upload(), 201),
      [`PUT ${UPLOADS}/up_1/parts/n`]: () => json({ part: 0, size: 4 }),
      [`POST ${UPLOADS}/up_1/complete`]: () => json({ uploadId: 'up_1', jobId: 'ins_1', status: 'inspecting' }, 202),
      [`GET ${UPLOADS}/up_1`]: [
        () => json(upload({ status: 'inspecting', jobId: 'ins_1', phase: 'spool', progress: 45 })),
        () => json(upload({ status: 'ready', jobId: 'ins_1' })),
      ],
      'GET /api/v1/views/transfer/packages/up_1': () => json(INSPECTED),
    })
    const heard: PackageProgress[] = []

    await expect(inspectViewPackage(FILE, { onProgress: (p) => heard.push(p) })).resolves.toEqual(INSPECTED)

    const create = vi.mocked(fetchWithTimeout).mock.calls[0]
    expect(JSON.parse(String(create[1]?.body))).toEqual({ fileName: FILE.name, size: 10 })
    expect(sentParts()).toEqual([['0', 4], ['1', 4], ['2', 2]])
    expect(calls().filter((c) => !c.includes('/parts/'))).toEqual([
      `POST ${UPLOADS}`, `POST ${UPLOADS}/up_1/complete`, `GET ${UPLOADS}/up_1`, `GET ${UPLOADS}/up_1`,
      'GET /api/v1/views/transfer/packages/up_1',
    ])
    expect(heard[0]).toEqual({ stage: 'upload', sent: 0, total: 10 })
    expect(heard).toContainEqual({ stage: 'upload', sent: 10, total: 10 })
    expect(heard).toContainEqual({ stage: 'check', progress: 45 })
    expect(localStorage.getItem(KEY)).toBe('up_1')          // a reopened wizard reads it again
  })

  it('resumes the upload of the same file, sending only the parts the server lacks', async () => {
    localStorage.setItem(KEY, 'up_1')
    serve({
      [`GET ${UPLOADS}/up_1`]: [
        () => json(upload({ received: [0, 2] })),
        () => json(upload({ status: 'ready', jobId: 'ins_1' })),
      ],
      [`PUT ${UPLOADS}/up_1/parts/n`]: () => json({ part: 1, size: 4 }),
      [`POST ${UPLOADS}/up_1/complete`]: () => json({ uploadId: 'up_1', jobId: 'ins_1', status: 'inspecting' }, 202),
      'GET /api/v1/views/transfer/packages/up_1': () => json(INSPECTED),
    })

    await inspectViewPackage(FILE)
    expect(sentParts()).toEqual([['1', 4]])
    expect(calls()).not.toContain(`POST ${UPLOADS}`)
  })

  it('reads a package already checked without sending or checking it again', async () => {
    localStorage.setItem(KEY, 'up_1')
    serve({
      [`GET ${UPLOADS}/up_1`]: () => json(upload({ status: 'ready', jobId: 'ins_1', received: [0, 1, 2] })),
      'GET /api/v1/views/transfer/packages/up_1': () => json(INSPECTED),
    })

    await expect(inspectViewPackage(FILE)).resolves.toEqual(INSPECTED)
    expect(calls()).toEqual([`GET ${UPLOADS}/up_1`, 'GET /api/v1/views/transfer/packages/up_1'])
  })

  it('sends afresh a file whose upload is about to expire: its data could no longer be imported', async () => {
    localStorage.setItem(KEY, 'up_old')
    serve({
      [`GET ${UPLOADS}/up_old`]: () => json(upload({
        uploadId: 'up_old', status: 'ready', received: [0, 1, 2], expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      })),
      [`POST ${UPLOADS}`]: () => json(upload(), 201),
      [`PUT ${UPLOADS}/up_1/parts/n`]: () => json({ part: 0, size: 4 }),
      [`POST ${UPLOADS}/up_1/complete`]: () => json({ uploadId: 'up_1', jobId: 'ins_1', status: 'inspecting' }, 202),
      [`GET ${UPLOADS}/up_1`]: () => json(upload({ status: 'ready', jobId: 'ins_1' })),
      'GET /api/v1/views/transfer/packages/up_1': () => json(INSPECTED),
    })

    await inspectViewPackage(FILE)
    expect(sentParts()).toHaveLength(3)
    expect(localStorage.getItem(KEY)).toBe('up_1')
  })

  it('says why a file is no package to import', async () => {
    serve({
      [`POST ${UPLOADS}`]: () => json(upload(), 201),
      [`PUT ${UPLOADS}/up_1/parts/n`]: () => json({ part: 0, size: 4 }),
      [`POST ${UPLOADS}/up_1/complete`]: () => json({ uploadId: 'up_1', jobId: 'ins_1', status: 'inspecting' }, 202),
      [`GET ${UPLOADS}/up_1`]: () => json(upload({
        status: 'invalid', jobId: 'ins_1', error: { code: 'view_file', message: 'This is a view file, without data.' },
      })),
    })

    const err = await inspectViewPackage(FILE).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ViewTransferError)
    expect(err).toMatchObject({ message: 'This is a view file, without data.', status: 422, code: 'view_file' })
  })
})

describe('exporting a view package', () => {
  const STARTED = {
    jobId: 'exp_1', graphId: 'g1', workspaceId: 'ws1', fileName: 'finance.v3.view-package.zip', status: 'pending' as const,
    views: [{ viewId: 'view_1', version: 3 }], requestId: 'req-1',
  }

  it('asks the server to build the package, and answers with the export job that builds it', async () => {
    serve({ 'POST /api/v1/views/transfer/packages': () => json(STARTED, 202) })

    await expect(startViewPackage([{ viewId: 'view_1' }], { scope: 'view', dataVersion: 'published', requestId: 'req-1' }))
      .resolves.toEqual(STARTED)
    expect(JSON.parse(String(vi.mocked(fetchWithTimeout).mock.calls[0][1]?.body))).toEqual({
      views: [{ viewId: 'view_1' }], scope: 'view', dataVersion: 'published', message: null, requestId: 'req-1',
    })
  })
})
