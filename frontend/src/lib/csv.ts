/**
 * CSV for files the browser builds itself (what is only in the browser — staged edits): cells
 * quoted as needed, and never a formula a spreadsheet would run (`= + - @`, tab, CR lead it with
 * `'`, as the server's exports do). A UTF-8 BOM so spreadsheets read names as UTF-8.
 */
import { triggerBrowserDownload } from '@/services/importExportApiService'

const FORMULA = /^[=+\-@\t\r]/

/** A value as a cell's text: lists joined, objects as JSON, Yes/No. */
export function csvText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) return value.join('; ')
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

/** One cell: defused, then quoted when it holds a comma, quote or line break. */
export function csvCell(value: unknown): string {
  let s = csvText(value)
  if (FORMULA.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const csvLine = (cells: readonly unknown[]) => `${cells.map(csvCell).join(',')}\r\n`

/** Save the lines as a file. */
export function downloadCsv(filename: string, lines: readonly string[]): void {
  const url = URL.createObjectURL(new Blob(['﻿', ...lines], { type: 'text/csv;charset=utf-8' }))
  triggerBrowserDownload(url, filename)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
