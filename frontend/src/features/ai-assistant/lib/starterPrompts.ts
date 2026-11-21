import type { AssistantPersona } from '../api/types'

/** Where the person is, as far as the first questions to offer go. */
export interface StarterSituation {
    onView: boolean
    selectedCount: number
    focused: boolean
}

/** Questions to start from, for where the person is and who they are asking. */
export function starterPrompts(persona: AssistantPersona, at: StarterSituation): string[] {
    if (persona === 'help') {
        return ['How do I share a view?', 'What is a data source?', 'How do I see where data comes from?']
    }
    if (at.onView && at.selectedCount > 1) {
        return ['What breaks if this changes?', 'Where does this come from?', 'Which of these hold PII?']
    }
    if (at.onView && (at.selectedCount === 1 || at.focused)) {
        return ['What breaks if this changes?', 'Where does this come from?', 'Does this hold PII?']
    }
    if (at.onView) {
        return ['What does this view show?', 'Which tables here hold PII?', 'Do we have views about supply-chain failures?']
    }
    return [
        'Do we have views about supply-chain failures?',
        'Which tables hold PII, and were any updated last week?',
        'Who owns our customer data?',
    ]
}
