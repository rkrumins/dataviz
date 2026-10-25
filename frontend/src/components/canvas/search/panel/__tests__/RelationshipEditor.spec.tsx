/**
 * RelationshipEditor — the connection card: a verb (is inside, contains,
 * feeds, is fed by, is linked to), how many relatives must match, their own
 * conditions (a nested builder), and More options — steps, through which
 * edges, which way, and conditions on every edge walked. framer-motion is
 * mocked (cached per tag) so the portal menus render synchronously.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSchemaStore } from '@/store/schema'
import type { Predicate, RelatedPredicate } from '@/types/search'

import { RelationContext } from '../relationContext'
import { RelationshipEditor } from '../RelationshipEditor'
import { optionsSummary } from '../relations'


vi.mock('framer-motion', () => {
    const cache = new Map<string, React.ComponentType<unknown>>()
    const passthrough = (tag: string) => {
        let cmp = cache.get(tag)
        if (!cmp) {
            cmp = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
                function MotionStub(props, ref) {
                    return React.createElement(tag, { ...props, ref })
                },
            ) as unknown as React.ComponentType<unknown>
            cache.set(tag, cmp)
        }
        return cmp
    }
    return {
        AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
        motion: new Proxy({}, { get: (_t, tag: string) => passthrough(tag) }),
    }
})


const DOMAIN: Predicate = { kind: 'entityType', op: 'in', values: ['domain'] }

function editor(value: RelatedPredicate, { depth = 0, rule = false, hideWhere = false } = {}) {
    const onChange = vi.fn()
    render(
        <RelationContext.Provider value={{ depth, rule }}>
            <RelationshipEditor
                value={value}
                onChange={onChange}
                discovery={{ allKeys: [], keysByEntityType: {}, tagValues: [], getValueSamples: () => [] }}
                knownEntityTypes={['dataset', 'domain']}
                discoveredLayers={[]}
                isRunning={false}
                hideWhere={hideWhere}
            />
        </RelationContext.Provider>,
    )
    return onChange
}

async function pick(menu: string, option: RegExp) {
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: menu }))
    await user.click(screen.getByRole('option', { name: option }))
}

async function moreOptions() {
    await userEvent.setup().click(screen.getByRole('button', { name: /More options/ }))
}


describe('RelationshipEditor', () => {
    const before = useSchemaStore.getState().schema
    beforeEach(() => {
        useSchemaStore.setState({ schema: {
            ...(before ?? {}),
            entityTypes: [{ id: 'dataJob', name: 'Data job' }, { id: 'dataset', name: 'Dataset' }],
            relationshipTypes: [
                { id: 'PRODUCES', name: 'Produces', sourceTypes: ['dataJob'], targetTypes: ['dataset'] },
                { id: 'CONTAINS', name: 'Contains', sourceTypes: [], targetTypes: [], isContainment: true },
            ],
            containmentEdgeTypes: ['CONTAINS'],
        } as unknown as typeof before })
    })
    afterEach(() => useSchemaStore.setState({ schema: before }))

    it('reads as what the entity does to its relatives, whose conditions a nested builder edits', () => {
        editor({ kind: 'related', axis: 'parent', where: DOMAIN })
        expect(screen.getByRole('button', { name: 'How it is related' })).toHaveTextContent('Is directly inside')
        expect(screen.getByRole('button', { name: 'How many of them' })).toHaveTextContent('at least one')
        expect(screen.getByText('container that…')).toBeInTheDocument()
        expect(screen.getByText('domain')).toBeInTheDocument()
    })

    it('says that no condition means any relative', () => {
        editor({ kind: 'related', axis: 'child' })
        expect(screen.getByText(/No condition: any entity will do/)).toBeInTheDocument()
    })

    it('turns the relationship into a count', async () => {
        const onChange = editor({ kind: 'related', axis: 'child', quantifier: 'all', where: DOMAIN })
        await pick('How many of them', /^a number of/)
        expect(onChange).toHaveBeenCalledWith({ kind: 'related', axis: 'child', where: DOMAIN,
            count: { op: 'gte', value: 1 } })
    })

    it('keeps what still applies when the verb changes, within the server’s reach', async () => {
        const onChange = editor({ kind: 'related', axis: 'ancestor', maxHops: 15, where: DOMAIN })
        await pick('How it is related', /^Is fed by/)
        expect(onChange).toHaveBeenCalledWith({ kind: 'related', axis: 'upstream', maxHops: 3, where: DOMAIN })
    })

    it('reads lineage forwards as Feeds and backwards as Is fed by, anything else as Is linked to', () => {
        editor({ kind: 'related', axis: 'downstream' })
        expect(screen.getByRole('button', { name: 'How it is related' })).toHaveTextContent('Feeds')
    })

    it('reads a link through every link, or edge types, as Is linked to', () => {
        editor({ kind: 'related', axis: 'upstream', edgeTypes: ['PRODUCES'] })
        expect(screen.getByRole('button', { name: 'How it is related' })).toHaveTextContent('Is linked to')
    })

    it('links either way through every link when Is linked to is chosen from the hierarchy', async () => {
        const onChange = editor({ kind: 'related', axis: 'parent', where: DOMAIN })
        await pick('How it is related', /^Is linked to/)
        expect(onChange).toHaveBeenCalledWith({ kind: 'related', axis: 'neighbor', edgeClass: 'links', where: DOMAIN })
    })

    it('links either way when Is linked to is chosen from Feeds, keeping its steps', async () => {
        const onChange = editor({ kind: 'related', axis: 'downstream', maxHops: 3 })
        await pick('How it is related', /^Is linked to/)
        expect(onChange).toHaveBeenCalledWith({ kind: 'related', axis: 'neighbor', maxHops: 3, edgeClass: 'links' })
    })

    it('turns Feeds into an outgoing link once every link is chosen', async () => {
        const onChange = editor({ kind: 'related', axis: 'downstream', maxHops: 3 })
        await moreOptions()
        await pick('Through which edges', /^Any link/)
        expect(onChange).toHaveBeenCalledWith({ kind: 'related', axis: 'downstream', maxHops: 3, edgeClass: 'links' })
    })

    it('reads an outgoing link through lineage as Feeds again', async () => {
        const onChange = editor({ kind: 'related', axis: 'downstream', edgeClass: 'links' })
        await moreOptions()
        await pick('Through which edges', /^Lineage/)
        expect(onChange).toHaveBeenCalledWith({ kind: 'related', axis: 'downstream' })
    })

    it('follows a link out, in or either way', async () => {
        const onChange = editor({ kind: 'related', axis: 'neighbor', edgeClass: 'links' })
        await moreOptions()
        await pick('Which way', /^Incoming/)
        expect(onChange).toHaveBeenCalledWith({ kind: 'related', axis: 'upstream', edgeClass: 'links' })
    })

    it('picks edge types by name, each with what it connects — never the hierarchy’s', async () => {
        const onChange = editor({ kind: 'related', axis: 'neighbor', edgeTypes: [] })
        // Open on what is left to do: the types to pick.
        const types = screen.getByRole('group', { name: 'Edge types' })
        expect(types).toHaveTextContent('Produces')
        expect(types).toHaveTextContent('Data job → Dataset')
        expect(types).not.toHaveTextContent('Contains')
        await userEvent.setup().click(screen.getByRole('checkbox', { name: /Produces/ }))
        expect(onChange).toHaveBeenCalledWith({ kind: 'related', axis: 'neighbor', edgeTypes: ['PRODUCES'] })
    })

    it('offers edge conditions only along connections', async () => {
        editor({ kind: 'related', axis: 'upstream' })
        await moreOptions()
        expect(screen.getByText('Only follow edges where…')).toBeInTheDocument()
    })

    it('has no options for one step of the hierarchy', () => {
        editor({ kind: 'related', axis: 'parent' })
        expect(screen.queryByRole('button', { name: /More options/ })).not.toBeInTheDocument()
    })

    it('stops nesting at the deepest relationship the server takes', () => {
        editor({ kind: 'related', axis: 'parent', where: { kind: 'related', axis: 'parent' } }, { depth: 2 })
        expect(screen.getByText(/Relationships nest 3 deep at most/)).toBeInTheDocument()
    })

    it('holds a display rule’s lineage to one step', async () => {
        editor({ kind: 'related', axis: 'downstream' }, { rule: true })
        await moreOptions()
        expect(screen.getByLabelText('Most steps')).toHaveAttribute('max', '1')
    })

    it('edits the verb and how many in the Sentence’s popup, the relative being a line of its own', () => {
        editor({ kind: 'related', axis: 'downstream', where: DOMAIN }, { hideWhere: true })
        expect(screen.getByRole('button', { name: 'How it is related' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'How many of them' })).toBeInTheDocument()
        expect(screen.queryByText('entity that…')).not.toBeInTheDocument()
        expect(screen.queryByText('domain')).not.toBeInTheDocument()
    })

    it('sums its options up in a few words', () => {
        expect(optionsSummary({ kind: 'related', axis: 'downstream', maxHops: 3 })).toBe('1–3 steps · lineage')
        expect(optionsSummary({ kind: 'related', axis: 'downstream', edgeTypes: ['PRODUCES'] }))
            .toBe('1 step · Produces edges · outgoing')
        expect(optionsSummary({ kind: 'related', axis: 'neighbor', edgeClass: 'links',
            edge: { kind: 'edgeHasProperty', key: 'k' } }))
            .toBe('1 step · any link · either way · only edges that meet conditions')
        expect(optionsSummary({ kind: 'related', axis: 'ancestor', minHops: 2, maxHops: 4 })).toBe('2–4 levels')
        expect(optionsSummary({ kind: 'related', axis: 'descendant' })).toBe('any depth')
        expect(optionsSummary({ kind: 'related', axis: 'child' })).toBeNull()
    })
})
