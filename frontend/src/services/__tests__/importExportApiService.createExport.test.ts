/**
 * createExport pins: it asks the server, with a POST, to prepare the export chosen (the format,
 * the view, the draft, new property columns, the file's name); an export being prepared is
 * remembered for its data source until forgotten, and anything else stored there reads as none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../apiClient', () => ({ authFetch: vi.fn() }))

import { authFetch } from '../apiClient'
import { createExport, preparedExport, rememberExport, type PreparedExport } from '../importExportApiService'

beforeEach(() => {
  localStorage.clear()
  vi.mocked(authFetch).mockReset()
})

describe('createExport', () => {
  it('asks the server to prepare the export chosen', async () => {
    vi.mocked(authFetch).mockResolvedValue({ jobId: 'j1', resultUri: 'r', status: 'pending' })
    await createExport({ wsId: 'ws1', dataSourceId: 'ds1', graphId: 'g1', viewId: 'v1', branchId: 'b1' }, 'csv',
      { props: ['Owner', 'PII'], filename: 'Finance-DWH' })

    const [url, init] = vi.mocked(authFetch).mock.calls[0]
    const sent = new URL(url, 'http://app')
    expect(sent.pathname).toBe('/api/v1/ws1/versioning/graphs/g1/exports')
    expect(Object.fromEntries(sent.searchParams)).toEqual(
      { format: 'csv', viewId: 'v1', branchId: 'b1', props: 'Owner,PII', filename: 'Finance-DWH' })
    expect(init).toMatchObject({ method: 'POST' })
  })

  it('remembers an export being prepared, for its data source, until it is forgotten', () => {
    const prepared: PreparedExport = { jobId: 'j1', fileName: 'Finance-DWH.csv', format: 'csv', total: 10, exact: true }
    rememberExport('ws1', 'g1', prepared)
    expect(preparedExport('ws1', 'g1')).toEqual(prepared)
    expect(preparedExport('ws1', 'g2')).toBeNull()

    rememberExport('ws1', 'g1', null)
    expect(preparedExport('ws1', 'g1')).toBeNull()
    localStorage.setItem('graph-export:ws1:g1', 'not json')
    expect(preparedExport('ws1', 'g1')).toBeNull()
  })
})
