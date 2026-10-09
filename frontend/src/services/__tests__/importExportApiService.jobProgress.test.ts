/**
 * What a job dialog says about a job beyond its queue position: how far a running import or view
 * package export has got, and that a job whose server stopped carries on where it left off rather
 * than starting over.
 */
import { describe, expect, it } from 'vitest'
import { jobProgressText, resumeNote, type Job } from '../importExportApiService'

const job = (extra: Partial<Job>): Job => ({ jobId: 'j1', jobType: 'ingest', graphId: 'g1', status: 'running', ...extra })

describe('jobProgressText', () => {
  it('tells how far a running import has got, step by step', () => {
    expect(jobProgressText(job({ phase: 'parse', processed: 0, total: 12000 }))).toBe('Reading the file… 12,000 rows so far')
    expect(jobProgressText(job({ phase: 'nodes', processed: 4000, total: 10000 }))).toBe('Applying the changes… 4,000 of 10,000 rows')
    expect(jobProgressText(job({ phase: 'edges', processed: 9000, total: 10000 }))).toBe('Applying the changes… 9,000 of 10,000 rows')
    expect(jobProgressText(job({ phase: 'replace', processed: 10000, total: 10000 }))).toBe('Removing what the file no longer holds…')
  })

  it('tells how far a view package’s export has got, from the records it wrote', () => {
    const exporting = (extra: Partial<Job>) => job({ jobType: 'export', ...extra })
    expect(jobProgressText(exporting({ phase: 'bundle' }))).toBe('Packing the views…')
    expect(jobProgressText(exporting({ phase: 'data', summary: null }))).toBe('Writing the data…')
    expect(jobProgressText(exporting({ phase: 'data', summary: { nodes: 1200, edges: 800, bytes: 4096 } })))
      .toBe('Writing the data… 1,200 entities and 800 relationships so far')
  })

  it('says nothing when there is nothing to tell', () => {
    expect(jobProgressText(job({ phase: null }))).toBeNull()                         // between steps
    expect(jobProgressText(job({ jobType: 'export', phase: null }))).toBeNull()      // tells it in its summary
    expect(jobProgressText(job({ status: 'pending', phase: 'queued' }))).toBeNull()
    expect(jobProgressText(job({ status: 'completed', phase: 'edges', processed: 1, total: 1 }))).toBeNull()
    expect(jobProgressText(null)).toBeNull()
  })
})

describe('resumeNote', () => {
  it('says a job whose server stopped answering is about to carry on elsewhere', () => {
    expect(resumeNote(job({ stale: true, attempt: 1 })))
      .toBe('The server running it stopped answering. Another one carries on from where it got to.')
  })

  it('says a job that was taken up again resumed where it left off', () => {
    expect(resumeNote(job({ attempt: 2 }))).toBe('Resumed where it left off (attempt 2).')
    expect(resumeNote(job({ status: 'pending', phase: 'queued', attempt: 1 }))).toBe('It resumes where it left off.')
  })

  it('says nothing for a job on its first run, or one that ended', () => {
    expect(resumeNote(job({ attempt: 1 }))).toBeNull()
    expect(resumeNote(job({ status: 'pending', phase: 'queued', attempt: 0 }))).toBeNull()
    expect(resumeNote(job({ status: 'completed', attempt: 3 }))).toBeNull()
    expect(resumeNote(job({ status: 'failed', attempt: 4 }))).toBeNull()
    expect(resumeNote(null)).toBeNull()
  })
})
