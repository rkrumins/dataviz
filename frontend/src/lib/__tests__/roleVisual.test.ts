/**
 * Every role reads as a name: the built-ins by their own label, and any other role by its name
 * in words — never the raw `snake_case` the API sends.
 */
import { FlaskConical, Sparkles } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { ROLE_NAMES } from '@/lib/roleNames'
import { customRoleVisual, humanizeRoleName, isBuiltinRole, roleOptionLabel, roleVisualFor } from '@/lib/roleVisual'

describe('role names, as people read them', () => {
    it('names the Playground member as one, with the Playground’s flask', () => {
        const v = roleVisualFor(ROLE_NAMES.WORKSPACE_PLAYGROUND_MEMBER)
        expect(v.label).toBe('Playground member')
        expect(v.icon).toBe(FlaskConical)
        expect(isBuiltinRole('workspace_playground_member')).toBe(true)
        expect(roleOptionLabel({ name: 'workspace_playground_member' })).toBe('Playground member')
    })

    it.each(Object.values(ROLE_NAMES))('gives %s a label without underscores', (name) => {
        expect(roleVisualFor(name).label).not.toMatch(/_/)
    })

    it('reads a custom role in words, still marked as custom', () => {
        expect(roleVisualFor('marketing_lead').label).toBe('Marketing lead')
        expect(customRoleVisual('data-quality__reviewers').label).toBe('Data quality reviewers')
        expect(roleVisualFor('marketing_lead').icon).toBe(Sparkles)
    })

    it('leaves a name already in words as it is, but for its first letter', () => {
        expect(humanizeRoleName('Finance Analysts')).toBe('Finance Analysts')
        expect(humanizeRoleName('auditors')).toBe('Auditors')
        expect(humanizeRoleName('')).toBe('')
    })
})
