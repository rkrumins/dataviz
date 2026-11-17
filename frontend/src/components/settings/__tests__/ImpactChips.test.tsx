/**
 * Impact chips (the review's "what changing it does"): each chip says its dimension and verdict,
 * and a tap opens the registry's sentence for it, so it reads on a phone, not only under a mouse.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SCHEMA, SETTINGS_BY_KEY as S } from '../__fixtures__/schema'
import { ImpactChips } from '../ImpactChips'
import { choiceImpacts } from '../impacts'
import { VERDICT_META } from '../meta'

describe('ImpactChips', () => {
    it('opens a chip’s sentence on a tap', async () => {
        const user = userEvent.setup()
        const inPlace = S['reads.mode'].choices.find((c) => c.id === 'in_place')!
        const impact = choiceImpacts(inPlace, S['reads.mode']).find((i) => i.verdict === 'better')!
        const name = SCHEMA.dimensions.find((d) => d.id === impact.dimension)!.label
        render(<ImpactChips impacts={[impact]} dimensions={SCHEMA.dimensions} />)

        await user.click(screen.getByRole('button', { name: `${name}: ${VERDICT_META.better.label}` }))
        expect(screen.getByRole('dialog', { name })).toHaveTextContent(impact.text)
    })
})
