/** What a failed turn says, by the service's code — plain words, and what to do next. */
const COPY: Record<string, { title: string; hint: string; retry: boolean }> = {
    not_configured: { title: 'The assistant isn’t set up yet', hint: 'An administrator needs to connect an AI model under Administration → AI.', retry: false },
    feature_disabled: { title: 'The assistant is switched off', hint: 'An administrator can turn it on under Administration → Features.', retry: false },
    missing_permission: { title: 'You can’t use the assistant here', hint: 'Ask an administrator for access to the assistant in this workspace.', retry: false },
    budget_exhausted: { title: 'You’ve reached today’s limit', hint: 'Your allowance of questions resets tomorrow.', retry: false },
    busy: { title: 'The assistant is busy', hint: 'You already have a question being answered. Try again in a moment.', retry: true },
    timeout: { title: 'That took too long', hint: 'Try again, or ask something narrower — one table, one view.', retry: true },
    llm_error: { title: 'The AI model didn’t answer properly', hint: 'Try again in a moment.', retry: true },
    platform_error: { title: 'The data it needed couldn’t be read', hint: 'Try again, or ask about something more specific.', retry: true },
    interrupted: { title: 'The answer stopped before it finished', hint: 'What arrived is shown above. You can ask again.', retry: true },
    internal: { title: 'Something went wrong on our side', hint: 'Try again in a moment.', retry: true },
}

export function errorCopy(code: string, message?: string): { title: string; hint: string; retry: boolean } {
    return COPY[code] ?? { title: 'The question couldn’t be answered', hint: message || 'Try again in a moment.', retry: true }
}
