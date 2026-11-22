/**
 * The import core's hooks.
 *
 * useFileIntake keeps what goes together — a things file and a connections file (one of each, a
 * newer one replacing the one before), or one standard file alone — names a file it can't read
 * and keeps the others. What goes up: a standard file as it is, in the format detected from it;
 * the simple files as one NDJSON file of the standard's rows, its types mapped, dated as the latest
 * of them so the same files chosen again resume their upload.
 *
 * useImportRun follows an import to its end: a failed job ends as a failure that says why — a file
 * over the row ceiling says the ceiling, plainly — and a finished one has its preview read.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/services/importExportApiService'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  importInParts: vi.fn(),
  getImport: vi.fn(),
  getImportPreview: vi.fn(),
  pollJob: vi.fn(),
}))

import { getImportPreview, importInParts, pollJob } from '@/services/importExportApiService'
import { useFileIntake } from '../useFileIntake'
import { byUrnFix, failureText, useImportRun } from '../useImportRun'

const file = (name: string, body: string, lastModified = 1000) => new File([body], name, { lastModified })
const THINGS = 'key,type,name\norders,Table,Orders\ndash,Dashboard,Sales\n'
const CONNECTIONS = 'from,type,to\norders,FEEDS,dash\n'
const STANDARD = 'kind,urn,entityType\nnode,urn:a,Table\n'

describe('useFileIntake', () => {
  it('keeps a things file and a connections file, a newer one replacing its kind, and converts them', async () => {
    const { result } = renderHook(() => useFileIntake())
    await act(() => result.current.add([file('things.csv', THINGS, 10), file('old-links.csv', CONNECTIONS, 20)]))
    await act(() => result.current.add([file('links.csv', CONNECTIONS, 30)]))
    expect(result.current.files.map((f) => f.name)).toEqual(['things.csv', 'links.csv'])
    expect(result.current.read).toMatchObject({ format: 'simple', things: [{ key: 'orders' }, { key: 'dash' }] })

    const up = result.current.upload({ entity: { Table: 'table' }, relationship: {} })!
    expect(up.format).toBe('ndjson')
    expect(up.file.name).toBe('things+links.ndjson')
    expect(up.file.lastModified).toBe(30)
    expect((await up.file.text()).split('\n')[0]).toContain('"entityType":"table"')
  })

  it('sends a standard file as it is, in the format detected from it, and takes it alone', async () => {
    const { result } = renderHook(() => useFileIntake())
    await act(() => result.current.add([file('things.csv', THINGS)]))
    const standard = file('export.tsv', STANDARD.replace(/,/g, '\t'))
    await act(() => result.current.add([standard]))
    expect(result.current.files).toEqual([standard])
    expect(result.current.read?.format).toBe('standard')
    expect(result.current.format).toBe('tsv')
    expect(result.current.autoDetected).toBe(true)
    expect(result.current.upload({ entity: {}, relationship: {} })).toEqual({ file: standard, format: 'tsv' })
  })

  it('names a file it can’t read, and keeps the others', async () => {
    const { result } = renderHook(() => useFileIntake())
    await act(() => result.current.add([file('things.csv', THINGS), file('broken.csv', 'from,type,to\n"open,FEEDS,b')]))
    expect(result.current.errors).toEqual([expect.stringMatching(/^broken\.csv: A quoted value opened on line 2/)])
    expect(result.current.files.map((f) => f.name)).toEqual(['things.csv'])
    expect(result.current.read?.things).toHaveLength(2)
  })

  it('says why an unsupported file can’t go, before anything is sent', async () => {
    const { result } = renderHook(() => useFileIntake())
    await act(() => result.current.add([file('legacy.xls', 'binary')]))
    expect(result.current.read?.format).toBe('server')
    expect(result.current.warning).toMatch(/legacy Excel files aren't supported yet/)
  })
})

describe('useImportRun', () => {
  beforeEach(() => {
    vi.mocked(importInParts).mockReset().mockResolvedValue({ jobId: 'j1', branchId: 'br1', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockReset()
    vi.mocked(getImportPreview).mockReset().mockResolvedValue({ sample: [{ rowIndex: 0, kind: 'node', status: 'new', label: 'a' }] } as never)
  })

  it('imports a file into the graph it is given, and reads a preview of what it did', async () => {
    vi.mocked(pollJob).mockResolvedValue({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'completed',
      summary: { new: 2, updated: 0, unchanged: 0, deleted: 0, invalid: 0 } } as Job)
    const { result } = renderHook(() => useImportRun())
    const f = file('rows.ndjson', '{}')
    await act(async () => { await result.current.start({ wsId: 'ws1', graphId: 'g1' }, f, { format: 'ndjson', autoPublish: true }) })
    expect(vi.mocked(importInParts).mock.calls[0].slice(0, 3)).toEqual(['ws1', 'g1', f])
    expect(vi.mocked(importInParts).mock.calls[0][3]).toMatchObject({ format: 'ndjson', autoPublish: true })
    expect(result.current.phase).toBe('done')
    expect(result.current.resultBranch).toBe('br1')
    await waitFor(() => expect(result.current.previewRows).toHaveLength(1))
  })

  it('ends a file over the row ceiling as a failure that says the ceiling', async () => {
    vi.mocked(pollJob).mockResolvedValue({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'failed',
      errorMessage: 'too_many_rows: This file has more than 200,000 rows, the most one import here may hold.',
      summary: { new: 0, updated: 0, unchanged: 0, deleted: 0, invalid: 0, failure: { code: 'too_many_rows', limit: 200000 } } } as Job)
    const { result } = renderHook(() => useImportRun())
    await act(async () => { await result.current.start({ wsId: 'ws1', graphId: 'g1' }, file('big.csv', 'x'), {}) })
    expect(result.current.phase).toBe('failed')
    expect(result.current.error).toBe('This file has more rows than an import here may carry (200,000). '
      + 'Split it into smaller files and import them one after another.')
  })

  it('reads the ceiling from the message when the summary doesn’t carry it', () => {
    const job = { jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'failed',
      errorMessage: 'too_many_rows: more than 50,000 rows' } as Job
    expect(failureText(job)).toMatch(/^This file has more rows than an import here may carry \(50,000\)\./)
  })

  it('says why an import couldn’t start, and starts again from where it was', async () => {
    vi.mocked(importInParts).mockRejectedValue(new Error('The server is busy'))
    const { result } = renderHook(() => useImportRun())
    await act(async () => { await result.current.start({ wsId: 'ws1', graphId: 'g1' }, file('a.csv', 'x'), {}) })
    expect(result.current).toMatchObject({ phase: 'failed', error: 'The server is busy' })
    act(() => result.current.reset())
    expect(result.current).toMatchObject({ phase: 'idle', error: null, job: null })
  })

  it('offers to find refused rows by their urn only for a job matched by a property alone', () => {
    const refused = { total: 2, byCode: {}, rows: [], hints: { by_urn: 2 } }
    const job = (identifier: string) => ({ identifier, summary: { refused } }) as unknown as Job
    expect(byUrnFix(job('prop.sap_id'))).toBe('prop.sap_id,urn')
    expect(byUrnFix(job('prop.sap_id,urn'))).toBeNull()
    expect(byUrnFix(job('urn'))).toBeNull()
  })
})
