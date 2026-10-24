/**
 * Whose keys the key components are about.
 *
 * On Account → API keys they are your own: the default, so nothing there
 * needs a provider. On a service account's page they are the account's — its
 * client calls the same routes under the account, and the words name it, for
 * a key made there reaches what the account reaches, not what you do. Proving
 * it's you before a key is made stays yours either way.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { apiKeyService, type KeyClient } from '@/services/apiKeyService'

/** The service account whose keys these are. */
export interface KeyAccount {
    id: string
    name: string
}

interface KeyScope {
    client: KeyClient
    account: KeyAccount
}

const Scope = createContext<KeyScope | null>(null)

export function KeyClientProvider({ client, account, children }: KeyScope & { children: ReactNode }) {
    const value = useMemo(() => ({ client, account }), [client, account])
    return <Scope.Provider value={value}>{children}</Scope.Provider>
}

/** The calls for these keys: your own, unless a provider says whose. */
export function useKeyClient(): KeyClient {
    return useContext(Scope)?.client ?? apiKeyService
}

/** The service account these keys belong to; null for your own. */
export function useKeyAccount(): KeyAccount | null {
    return useContext(Scope)?.account ?? null
}

/** The keys' owner in a sentence: you, or the service account. */
export interface OwnerWords {
    /** The keys are your own. */
    you: boolean
    /** Opening a sentence: "You" / "“Metadata sync”". */
    subject: string
    /** After a verb: "you" / "“Metadata sync”". */
    object: string
    /** "your" / "“Metadata sync”’s". */
    possessive: string
    /** The verbs that do not agree with both: "have"/"has", "are"/"is". */
    has: 'have' | 'has'
    is: 'are' | 'is'
}

export function ownerWords(account: KeyAccount | null): OwnerWords {
    if (!account) return { you: true, subject: 'You', object: 'you', possessive: 'your', has: 'have', is: 'are' }
    const name = `“${account.name}”`
    return { you: false, subject: name, object: name, possessive: `${name}’s`, has: 'has', is: 'is' }
}

export function useOwnerWords(): OwnerWords {
    return ownerWords(useKeyAccount())
}
