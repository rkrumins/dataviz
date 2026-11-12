/**
 * The refused rows panel: it opens from the job's own report with no request, says what to do about
 * each reason, filters the rows by reason, loads every refused row only when asked, a page at a
 * time, and downloads them all as CSV.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  getRefusedRows: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}))

import {
  getRefusedRows, refusedRowsCsv, triggerBrowserDownload, whereText, type RefusedRow, type RefusedRows,
} from '@/services/importExportApiService'
import { RefusedRowsPanel } from '../RefusedRowsPanel'

const row = (rowIndex: number, code: string, label = '', reason = 'why', at: RefusedRow['at'] = null): RefusedRow =>
  ({ rowIndex, kind: code === 'end_not_found' ? 'edge' : 'node', label, code, reason, at })

const report: RefusedRows = {
  total: 3,
  byCode: { end_not_found: 2, no_key: 1 },
  fixes: { end_not_found: 'Add a node row for a missing end.', no_key: 'Give the row a urn.' },
  rows: [row(12, 'end_not_found', 'FLOWS_TO a → x', 'its target names no node', { line: 14 }),
    row(40, 'no_key', '', 'why', { sheet: 'Nodes', row: 41 })],
}

function panel(props: Partial<Parameters<typeof RefusedRowsPanel>[0]> = {}) {
  return render(<RefusedRowsPanel report={report} wsId="ws1" graphId="g1" jobId="j1" {...props} />)
}

beforeEach(() => {
  vi.mocked(getRefusedRows).mockReset()
  vi.mocked(triggerBrowserDownload).mockReset()
})

afterEach(() => vi.restoreAllMocks())

describe('RefusedRowsPanel', () => {
  it('opens from the report at once: the reasons by count, what to do about each, and the first rows', () => {
    panel()
    expect(screen.getByRole('heading', { name: '3 rows refused' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /2 end_not_found/ })).toBeInTheDocument()
    expect(screen.getByText(/Add a node row for a missing end/)).toBeInTheDocument()
    expect(screen.getByText(/Give the row a urn/)).toBeInTheDocument()
    expect(screen.getByText('FLOWS_TO a → x')).toBeInTheDocument()
    expect(screen.getByText(/its target names no node/)).toBeInTheDocument()
    expect(screen.getByText('Showing 2 of 3')).toBeInTheDocument()
    expect(screen.getByText('line 14')).toBeInTheDocument()
    expect(screen.getByText('Nodes row 41')).toBeInTheDocument()
    expect(getRefusedRows).not.toHaveBeenCalled()
  })

  it('shows the rows, and the fix, of the reason chosen', async () => {
    panel()
    await userEvent.click(screen.getByRole('button', { name: /1 no_key/ }))
    expect(screen.getByRole('button', { name: /1 no_key/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('FLOWS_TO a → x')).not.toBeInTheDocument()
    expect(screen.queryByText(/Add a node row for a missing end/)).not.toBeInTheDocument()
    expect(screen.getByText(/Give the row a urn/)).toBeInTheDocument()
    expect(screen.getByText('Showing 1 of 1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /All · 3/ }))
    expect(screen.getByText('FLOWS_TO a → x')).toBeInTheDocument()
  })

  it('loads every refused row only when asked, a page at a time', async () => {
    vi.mocked(getRefusedRows)
      .mockResolvedValueOnce({ rows: [row(12, 'end_not_found', 'FLOWS_TO a → x'), row(40, 'no_key')], nextAfter: 40 })
      .mockResolvedValueOnce({ rows: [row(77, 'end_not_found', 'FLOWS_TO b → y')], nextAfter: null })
    panel()
    await userEvent.click(screen.getByRole('button', { name: 'Show all 3' }))
    expect(getRefusedRows).toHaveBeenLastCalledWith('ws1', 'g1', 'j1', null)
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(getRefusedRows).toHaveBeenLastCalledWith('ws1', 'g1', 'j1', 40)
    expect(await screen.findByText('FLOWS_TO b → y')).toBeInTheDocument()
    expect(screen.getByText('Showing 3 of 3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Load more|Show all/ })).not.toBeInTheDocument()
  })

  it('downloads every refused row as CSV, each with what to do', async () => {
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blobs.push(b as Blob); return 'blob:refused' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.mocked(getRefusedRows)
      .mockResolvedValueOnce({ rows: [row(12, 'end_not_found'), row(40, 'no_key')], nextAfter: 40 })
      .mockResolvedValueOnce({ rows: [row(77, 'end_not_found')], nextAfter: null })
    panel()
    await userEvent.click(screen.getByRole('button', { name: /Download CSV/ }))
    await vi.waitFor(() => expect(triggerBrowserDownload).toHaveBeenCalledWith('blob:refused', 'refused-rows-j1.csv'))
    const csv = await blobs[0].text()
    expect(csv.split('\n').filter(Boolean)).toHaveLength(4)
    expect(csv).toContain('#77,77,edge,,end_not_found,why,Add a node row for a missing end.')
  })

  it('without the import, lists the report’s rows and loads nothing more', () => {
    panel({ jobId: null })
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument()
  })
})

describe('whereText', () => {
  it('says where a row is as its file shows it', () => {
    expect(whereText({ rowIndex: 4, at: { line: 6 } })).toBe('line 6')
    expect(whereText({ rowIndex: 4, at: { sheet: 'Edges', row: 7 } })).toBe('Edges row 7')
    expect(whereText({ rowIndex: 4, at: { item: 0 } })).toBe('item 0')
    expect(whereText({ rowIndex: 4, at: null })).toBe('#4')
  })
})

describe('refusedRowsCsv', () => {
  it('quotes what a spreadsheet would split, and adds each row’s fix', () => {
    const csv = refusedRowsCsv([row(3, 'no_key', 'a, "b"', 'line one\nline two', { item: 3 })],
      { no_key: 'Give it a urn.' })
    expect(csv).toBe('where,rowIndex,kind,label,code,reason,fix\n'
      + 'item 3,3,node,"a, ""b""",no_key,"line one\nline two",Give it a urn.\n')
  })
})
