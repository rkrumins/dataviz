/**
 * The section's small vocabularies: how a change was made, and where a category's section is.
 */
import type { ChangeSource } from '@/services/settingsService'

/** How a change set was made. */
export const SOURCE_LABEL: Record<ChangeSource, string> = {
    api: 'Saved in settings',
    legacy_api: 'Saved through the old settings',
    migration: 'Carried over when settings moved here',
    revert: 'Put back',
}

/** The anchor of a category's section. */
export const categoryAnchor = (id: string) => `category-${id}`
