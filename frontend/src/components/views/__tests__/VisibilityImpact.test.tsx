/**
 * The panel exists to answer two questions the tier tiles never could:
 * who is "everyone", and what can they do to my view. These tests pin
 * the parts that would quietly become wrong — a count rendered as zero
 * when it is merely unknown, a delta claimed against a tier that was
 * never saved, and the reassurance half going missing.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { VisibilityImpact } from '../VisibilityImpact'

const COUNTS = {
    workspaceMemberCount: 12,
    platformUserCount: 1240,
    explicitGrantCount: 0,
}

describe('the audience', () => {
    it('sizes the workspace tier in people, not in the word "workspace"', () => {
        render(<VisibilityImpact selected="workspace" counts={COUNTS} workspaceName="Finance" />)
        expect(screen.getByText('Everyone in Finance')).toBeTruthy()
        expect(screen.getByText(/12 people/)).toBeTruthy()
    })

    it('gives "anyone signed in" a number too', () => {
        render(<VisibilityImpact selected="enterprise" counts={COUNTS} />)
        // Rounded: a precise-looking figure invites someone to check it
        // against a user list that moves every day.
        expect(screen.getByText(/1\.2k people/)).toBeTruthy()
    })

    it('says it is counting rather than claiming zero when it does not know', () => {
        // Printing "0 people" where we merely don't know would be wrong
        // in the one direction that matters for a sharing decision.
        render(<VisibilityImpact selected="enterprise" counts={null} />)
        expect(screen.getByText(/counting/i)).toBeTruthy()
        expect(screen.queryByText(/0 people/)).toBeNull()
    })
})

describe('the change', () => {
    it('states the before and after when a saved tier exists', () => {
        render(
            <VisibilityImpact
                selected="enterprise" saved="workspace"
                counts={COUNTS} workspaceName="Finance"
            />,
        )
        expect(screen.getByText('Workspace')).toBeTruthy()
        expect(screen.getByText('Enterprise')).toBeTruthy()
        expect(screen.getByText(/more people/)).toBeTruthy()
    })

    it('says fewer people when the change narrows the audience', () => {
        render(<VisibilityImpact selected="private" saved="workspace" counts={COUNTS} />)
        expect(screen.getByText(/fewer people/)).toBeTruthy()
    })

    it('claims no change while creating, where nothing is saved yet', () => {
        render(<VisibilityImpact selected="enterprise" counts={COUNTS} />)
        expect(screen.queryByText(/more people/)).toBeNull()
        expect(screen.queryByText(/fewer people/)).toBeNull()
    })
})

describe('what the audience can do', () => {
    it('says publishing gives read-only reach into the data source', () => {
        // The thing a person most needs to know before publishing, and
        // the one the word "Enterprise" hides completely.
        render(<VisibilityImpact selected="enterprise" counts={COUNTS} />)
        expect(screen.getByText(/read-only access to the data source/i)).toBeTruthy()
    })

    it('gives the reassurance half equal billing', () => {
        // The fear that stops people sharing is losing control of the
        // thing — so "they can't" is a column, not a tooltip.
        render(<VisibilityImpact selected="enterprise" counts={COUNTS} />)
        expect(screen.getByText(/cannot change this view/i)).toBeTruthy()
        expect(screen.getByText(/cannot see other views/i)).toBeTruthy()
    })
})

describe('when the tier needs approval', () => {
    it('says plainly that nothing is published yet', () => {
        render(
            <VisibilityImpact
                selected="enterprise" counts={COUNTS}
                requiresApproval
                approvalHint="Needs approval — ask a workspace admin to publish"
            />,
        )
        expect(screen.getByText(/nothing is published yet/i)).toBeTruthy()
        expect(screen.getByText(/ask a workspace admin to publish/i)).toBeTruthy()
    })

    it('stays quiet when the tier applies directly', () => {
        render(<VisibilityImpact selected="enterprise" counts={COUNTS} />)
        expect(screen.queryByText(/nothing is published yet/i)).toBeNull()
    })
})
