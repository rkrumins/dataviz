/**
 * useSemanticLayerAccess(ontology?) — the org rules alone, or a layer's own answer over them: what
 * may be done to the layer comes from the layer; export, history and suggest stay with the
 * switches, except that a maker's own layer can always be exported and its history read; and an
 * owned layer is never said to be blocked by the org switches.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayerAccess } from '@/services/ontologyDefinitionService'

let features: Record<string, boolean>
let perms: Record<string, boolean>
vi.mock('@/store/features', () => ({ useFeature: (k: string) => !!features[k] }))
vi.mock('@/store/auth', () => ({
    usePermission: (p: string) => !!perms[p],
    useAnyWorkspacePermission: (p: string) => !!perms[p],
}))

import { useSemanticLayerAccess } from './useSemanticLayerAccess'

const ALL_ON = {
    semanticLayerEditMode: true, semanticLayerNonAdminEditing: true, semanticLayerImportEnabled: true,
    semanticLayerExportEnabled: true, semanticLayerAutoSuggest: true, semanticLayerVersionHistory: true,
}
const NONE: LayerAccess = { canEdit: false, canPublish: false, canDelete: false, canClone: false, canShare: false, canAssign: false, isOwn: false }
const OWN: LayerAccess = { canEdit: true, canPublish: true, canDelete: true, canClone: true, canShare: true, canAssign: true, isOwn: true }

const access = (ontology?: { access?: LayerAccess }) => renderHook(() => useSemanticLayerAccess(ontology)).result.current

beforeEach(() => {
    features = { ...ALL_ON }
    perms = {}
})

describe('useSemanticLayerAccess', () => {
    it('with no layer access, answers by the org rules alone', () => {
        perms = { 'workspace:ontology:manage': true }
        expect(access()).toMatchObject({
            canEdit: true, canImport: true, canExport: true, canSuggest: true, canSeeHistory: true, canPublish: true,
            canDelete: true, canClone: true, canShare: false, canAssign: true, isOwn: false, editingBlockedBy: null,
        })
        // A layer from a server that predates `access`: the same.
        expect(access({})).toEqual(access())

        perms = {}
        expect(access()).toMatchObject({ canEdit: false, canPublish: false, canClone: false, canDelete: false, editingBlockedBy: 'permission' })
    })

    it('an org layer takes its own answer for what may be done to it, and keeps the switches for the rest', () => {
        perms = { 'workspace:ontology:manage': true }
        features = { ...ALL_ON, semanticLayerImportEnabled: false, semanticLayerExportEnabled: false, semanticLayerVersionHistory: false }
        const org = { ...NONE, canEdit: true, canPublish: true, canClone: true, canAssign: true }
        expect(access({ access: org })).toMatchObject({
            canEdit: true, canPublish: true, canClone: true, canDelete: false, canAssign: true, isOwn: false,
            canImport: false, canExport: false, canSeeHistory: false, canSuggest: true, editingBlockedBy: null,
        })

        // The server says no where the org rules alone would have said yes: someone else's layer.
        expect(access({ access: NONE })).toMatchObject({ canEdit: false, canPublish: false, canImport: false, editingBlockedBy: 'permission' })

        // Editing is off: the layer says no, and why is still the switch.
        features = { ...ALL_ON, semanticLayerEditMode: false }
        expect(access({ access: { ...org, canEdit: false } }).editingBlockedBy).toBe('feature-off')
    })

    it('a maker’s own layer is theirs to change, export and read the history of, whatever the switches say', () => {
        features = {}  // every semantic-layer switch off, and no ontology:manage
        const own = access({ access: OWN })
        expect(own).toMatchObject({
            canEdit: true, canPublish: true, canDelete: true, canClone: true, canShare: true, isOwn: true,
            canImport: true, canExport: true, canSeeHistory: true, editingBlockedBy: null,
        })
        // Suggest scores layers against a graph: still the org's switch and permission.
        expect(own.canSuggest).toBe(false)

        // Never blocked by the org switches: a no on one's own layer is the layer's answer.
        expect(access({ access: { ...OWN, canEdit: false } }).editingBlockedBy).toBe('permission')
    })
})
