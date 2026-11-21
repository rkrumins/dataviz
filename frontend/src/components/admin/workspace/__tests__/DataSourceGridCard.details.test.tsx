/**
 * A source's card, with data source details on: two lines of what it is, up to three tags
 * (a click narrows the grid to one) and a count of the rest, and its trust badges. The
 * Sources filter bar above the grid. With the switch off, the card is as it was.
 */
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataSourceGridCard } from '../DataSourceGridCard'
import { DataSourceFilterBar } from '../DataSourceFilterBar'
import { NO_FILTER, type DataSourceFilter } from '@/lib/dataSourceFilter'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import type { DataSourceResponse } from '@/services/workspaceService'

const ds = (over: Partial<DataSourceResponse> = {}) => ({
    id: 'ds_gl', workspaceId: 'ws1', label: 'General Ledger', accessLevel: 'read', isPrimary: false, isActive: true,
    aggregationStatus: 'ready', aggregationEdgeCount: 0, createdAt: '', updatedAt: '2026-11-01T00:00:00Z',
    catalogDescription: 'Balances and journals, as finance keeps them.',
    tags: ['finance', 'month-end', 'gl', 'audit', 'sox'], trustStatus: 'certified', classification: 'confidential',
    ...over,
}) as DataSourceResponse

beforeEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, dataSourceMetadataEnabled: true } }))
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } }))

describe('DataSourceGridCard with details', () => {
    it('says what it is, shows three tags and counts the rest, with its badges; a tag click narrows the grid', async () => {
        const onTagClick = vi.fn()
        const onSelect = vi.fn()
        render(<DataSourceGridCard ds={ds()} viewCount={2} isSelected={false} onSelect={onSelect} onTagClick={onTagClick} />)
        expect(screen.getByText('Balances and journals, as finance keeps them.')).toBeInTheDocument()
        expect(screen.getByText('Certified')).toBeInTheDocument()
        expect(screen.getByText('Confidential')).toBeInTheDocument()
        expect(screen.getAllByRole('button', { name: /Show the sources tagged/ })).toHaveLength(3)
        expect(screen.getByText('+2')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Show the sources tagged month-end' }))
        expect(onTagClick).toHaveBeenCalledWith('month-end')
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('is as it was with the switch off', () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
        render(<DataSourceGridCard ds={ds()} viewCount={2} isSelected={false} onSelect={vi.fn()} onTagClick={vi.fn()} />)
        expect(screen.queryByText('Balances and journals, as finance keeps them.')).toBeNull()
        expect(screen.queryByText('Certified')).toBeNull()
        expect(screen.queryByRole('list', { name: 'Tags' })).toBeNull()
    })
})

describe('DataSourceFilterBar', () => {
    function Bar({ onChange }: { onChange: (f: DataSourceFilter) => void }) {
        const [f, setF] = useState<DataSourceFilter>({ ...NO_FILTER, tag: 'FINANCE' })
        const sources = [ds(), ds({ id: 'ds_r', label: 'Risk', tags: ['risk', 'Finance'] })]
        return <DataSourceFilterBar sources={sources} filter={f} shown={1} onChange={next => { setF(next); onChange(next) }} />
    }

    it('lists the tags in use with counts, shows a card’s tag as chosen, narrows by sensitivity and status, and clears', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Bar onChange={onChange} />)
        const tag = screen.getByRole('combobox', { name: 'Tag' })
        expect(tag).toHaveValue('finance')
        expect(screen.getByRole('option', { name: 'finance (2)' })).toBeInTheDocument()
        await user.selectOptions(screen.getByRole('combobox', { name: 'Sensitivity' }), 'restricted')
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ classification: 'restricted' }))
        await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'deprecated')
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ trustStatus: 'deprecated' }))
        expect(screen.getByText('1 of 2')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Clear/ }))
        expect(onChange).toHaveBeenLastCalledWith(NO_FILTER)
    })
})
