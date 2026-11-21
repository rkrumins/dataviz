/**
 * The knowledge collections: each one's state, version, model, size and
 * freshness, its error when it has one, and Re-index.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { KnowledgeStatus } from '@/services/aiAdminService'
import { CollectionsTable, SourceTestView } from '../knowledge/KnowledgeTab'

const STATUS: KnowledgeStatus = {
    store: 'pgvector',
    collections: [
        { name: 'docs', status: 'ready', version: 3, model: 'text-embedding-3-small', dimensions: 1536,
          documents: 212, chunks: 1840, lastSyncAt: '2026-11-21T08:00:00Z', lag: 0, error: null },
        { name: 'views', status: 'failed', version: 1, model: 'text-embedding-3-small', dimensions: 1536,
          documents: 40, chunks: 40, lastSyncAt: null, lag: 12, error: 'The embedding endpoint answered HTTP 429.' },
    ],
}

const rowOf = (label: string) => screen.getByText(label).closest('tr')!

describe('the collections table', () => {
    it('shows each collection’s state, version, model, size and lag', () => {
        render(<CollectionsTable status={STATUS} onReindex={vi.fn()} />)
        expect(screen.getByText('pgvector')).toBeInTheDocument()
        const docs = rowOf('Guide and docs')
        for (const text of ['Ready', '3', 'text-embedding-3-small', '1,536', '212', '1,840', 'Up to date']) {
            expect(docs).toHaveTextContent(text)
        }
        const views = rowOf('Views')
        expect(views).toHaveTextContent('Failed')
        expect(views).toHaveTextContent('12 waiting')
        expect(within(views).getByText('Never')).toBeInTheDocument()
        expect(screen.getByText('The embedding endpoint answered HTTP 429.')).toBeInTheDocument()
    })

    it('re-indexes the collection asked for, and not one already building', async () => {
        const onReindex = vi.fn()
        const building: KnowledgeStatus = { ...STATUS, collections: [{ ...STATUS.collections[0], status: 'building' }, STATUS.collections[1]] }
        render(<CollectionsTable status={building} onReindex={onReindex} />)
        expect(screen.getByRole('button', { name: 'Re-index Guide and docs' })).toBeDisabled()
        await userEvent.click(screen.getByRole('button', { name: 'Re-index Views' }))
        expect(onReindex).toHaveBeenCalledWith('views')
    })

    it('says when there is no vector store and words alone are searched', () => {
        render(<CollectionsTable status={{ store: 'none', collections: [{ ...STATUS.collections[0], status: 'lexical' }] }} onReindex={vi.fn()} />)
        expect(screen.getByText(/searched by their words only/)).toBeInTheDocument()
        expect(rowOf('Guide and docs')).toHaveTextContent('Words only')
    })
})

describe('testing an external source', () => {
    it('shows what it answered with', () => {
        render(<SourceTestView report={{ ok: true, detail: 'Answered with 2 result(s).',
            sample: [{ title: 'Runbook: restarts', url: 'https://wiki.example.com/r' }, { title: 'On-call' }] }} />)
        const sample = screen.getByRole('list', { name: 'Sample results' })
        expect(within(sample).getAllByRole('listitem').map((li) => li.textContent))
            .toEqual(['Runbook: restartshttps://wiki.example.com/r', 'On-call'])
    })

    it('shows why it failed, with the code', () => {
        render(<SourceTestView report={{ ok: false, code: 'auth', detail: 'The sign-in was refused.' }} />)
        expect(screen.getByRole('status')).toHaveTextContent('The sign-in was refused. (auth)')
        expect(screen.queryByRole('list', { name: 'Sample results' })).not.toBeInTheDocument()
    })
})
