/**
 * A recorded value, drawn as what it is: yes/no as a pill, a duration in its
 * units, an instant as a readable time, a person as a face, an id named where
 * the record named it, a link that leaves safely, a status in its tone — and
 * whatever it cannot place, verbatim.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const { peopleById } = vi.hoisted(() => ({ peopleById: vi.fn() }))
vi.mock('@/services/userDirectoryService', () => ({ peopleById }))

import { KeyValueList, ValueView, humanizeKey } from '../ValueView'

function wrap(ui: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('humanizeKey', () => {
    it('reads a key as a label, without the unit the value already shows', () => {
        expect(humanizeKey('triggerSource')).toBe('Trigger source')
        expect(humanizeKey('jobId')).toBe('Job')
        expect(humanizeKey('data_source_id')).toBe('Data source')
        expect(humanizeKey('timeout_secs')).toBe('Timeout')
        expect(humanizeKey('writeTimeoutS')).toBe('Write timeout')
        expect(humanizeKey('replica_ack_timeout_ms')).toBe('Replica ack timeout')
        expect(humanizeKey('status')).toBe('Status')
        expect(humanizeKey('items')).toBe('Items')
    })
})

describe('ValueView', () => {
    it('draws yes and no as pills, and nothing as a dash', () => {
        wrap(<><ValueView value={true} /><ValueView value={false} /><ValueView value={null} /></>)
        expect(screen.getByText('Yes')).toBeInTheDocument()
        expect(screen.getByText('No')).toBeInTheDocument()
        expect(screen.getByText('—')).toBeInTheDocument()
    })

    it('gives numbers their units from their key', () => {
        wrap(<>
            <ValueView value={300} keyHint="timeout_secs" />
            <ValueView value={90_000} keyHint="replicaAckTimeoutMs" />
            <ValueView value={5_242_880} keyHint="sizeBytes" />
            <ValueView value={0.25} keyHint="manualShare" />
            <ValueView value={50_000} keyHint="cap" />
        </>)
        expect(screen.getByText('5 min')).toBeInTheDocument()
        expect(screen.getByText('1 min 30 s')).toBeInTheDocument()
        expect(screen.getByText('5.0 MB')).toBeInTheDocument()
        expect(screen.getByText('25%')).toBeInTheDocument()
        expect(screen.getByText((50_000).toLocaleString())).toBeInTheDocument()
    })

    it('draws an instant as a time, exact on hover', () => {
        wrap(<ValueView value="2026-10-12T08:41:07Z" keyHint="createdAt" />)
        expect(document.querySelector('time')).toHaveAttribute('dateTime', '2026-10-12T08:41:07.000Z')
    })

    it('draws a person by name, and other ids by the name the record gave them', async () => {
        peopleById.mockResolvedValue([{ id: 'usr_ana', displayName: 'Ana Okafor', email: null, deleted: false }])
        wrap(<>
            <ValueView value="usr_ana" />
            <ValueView value="agg_3f9c0a1b2c3d" names={{ agg_3f9c0a1b2c3d: 'Nightly ledger run' }} />
            <ValueView value="batch-7" keyHint="batchId" />
        </>)
        expect(await screen.findByRole('link', { name: 'Ana Okafor' })).toBeInTheDocument()
        expect(screen.getByText('Nightly ledger run')).toBeInTheDocument()
        expect(screen.getByText('agg_3f9c0a1b2c3d')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Copy agg_3f9c0a1b2c3d' })).toBeInTheDocument()
        // A key that says "id" makes its value one, whatever it looks like.
        expect(screen.getByRole('button', { name: 'Copy batch-7' })).toBeInTheDocument()
    })

    it('opens a link in a new tab without handing it the page', () => {
        wrap(<ValueView value="https://status.example.com/incidents/42" />)
        const link = screen.getByRole('link', { name: /status\.example\.com/ })
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow')
    })

    it('draws a status in its tone and a code as a code', () => {
        wrap(<><ValueView value="failed" /><ValueView value="external_wins" /></>)
        expect(screen.getByText('failed').className).toMatch(/rose/)
        expect(screen.getByText('external_wins').className).toMatch(/font-mono/)
    })

    it('shortens long text until asked', async () => {
        const text = 'x'.repeat(300)
        wrap(<ValueView value={text} />)
        expect(screen.queryByText(text)).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Show all' }))
        expect(screen.getByText(text)).toBeInTheDocument()
    })

    it('draws lists as chips, capped, and objects as labelled values — never JSON', () => {
        const many = Array.from({ length: 15 }, (_, i) => `tag${i}`)
        wrap(<>
            <ValueView value={many} />
            <ValueView value={{ lens: 'operations', hasReason: true }} />
        </>)
        expect(screen.getByText('tag0')).toBeInTheDocument()
        expect(screen.queryByText('tag14')).not.toBeInTheDocument()
        expect(screen.getByText('+3 more')).toBeInTheDocument()
        expect(screen.getByText('Lens')).toBeInTheDocument()
        expect(screen.getByText('Has reason')).toBeInTheDocument()
        expect(screen.queryByText(/[{}]/)).not.toBeInTheDocument()
    })
})

describe('KeyValueList', () => {
    it('labels each value and draws it by kind', () => {
        wrap(<KeyValueList data={{ triggerSource: 'manual', reaggregate: false }} />)
        expect(screen.getByText('Trigger source')).toBeInTheDocument()
        expect(screen.getByText('manual')).toBeInTheDocument()
        expect(screen.getByText('Reaggregate')).toBeInTheDocument()
        expect(screen.getByText('No')).toBeInTheDocument()
    })
})
