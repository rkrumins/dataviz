/**
 * The banner above the builder, seen by someone holding a share link.
 *
 * `/search/discover` refuses capability identities, so before this the
 * Refine builder opened on a red "Discovery failed — autocomplete will
 * be empty" card, every time, for a viewer who could do nothing about
 * it. A refusal is not a fault: the builder simply offers no property
 * keys, exactly as it does on a source that has none.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UseDiscoveryResult } from '../useDiscovery'

const discovery = {
    current: {} as UseDiscoveryResult,
}

vi.mock('../useDiscovery', () => ({
    useDiscovery: () => discovery.current,
}))

import { PredicateBuilder } from '../PredicateBuilder'


function stubDiscovery(over: Partial<UseDiscoveryResult> = {}): UseDiscoveryResult {
    return {
        discovery: null,
        isInitialLoading: false,
        error: null,
        unavailable: false,
        allKeys: [],
        keysByEntityType: {},
        tagValues: [],
        getValueSamples: () => [],
        edgeTypes: [],
        keysByEdgeType: {},
        getEdgeValueSamples: () => [],
        ...over,
    }
}

function renderBuilder(over: Partial<UseDiscoveryResult> = {}) {
    discovery.current = stubDiscovery(over)
    render(
        <PredicateBuilder
            viewId="view-1"
            onBack={vi.fn()}
            onRun={vi.fn()}
            isRunning={false}
        />,
    )
}


beforeEach(() => {
    vi.clearAllMocks()
})


describe('the discovery banner', () => {
    it('says nothing at all when discovery is not available for this link', () => {
        renderBuilder({ unavailable: true })

        expect(screen.queryByText(/Discovery failed/)).toBeNull()
        expect(screen.queryByText(/No queryable properties/)).toBeNull()
        expect(screen.queryByText(/Loading property keys/)).toBeNull()
        expect(screen.queryByText(/Auto-fill ready/)).toBeNull()
    })

    it('still reports a real failure, which the user or an admin can act on', () => {
        renderBuilder({ error: new Error('API Error 500: boom') })

        expect(screen.getByText(/Discovery failed/)).toBeTruthy()
    })

    it('still says so when the source genuinely has nothing to offer', () => {
        renderBuilder()

        expect(screen.getByText(/No queryable properties/)).toBeTruthy()
    })
})
