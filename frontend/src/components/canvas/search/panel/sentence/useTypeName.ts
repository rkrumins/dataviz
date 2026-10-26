import { useMemo } from 'react'

import { useSchemaStore } from '@/store/schema'


/** A type's name as people read it, one or several: "Dataset", "Datasets". */
export function useTypeName(): (type: string, plural?: boolean) => string {
    const entityTypes = useSchemaStore((s) => s.schema?.entityTypes)
    return useMemo(() => {
        const byId = new Map((entityTypes ?? []).map((t) => [t.id.toLowerCase(), t]))
        return (type: string, plural = false) => {
            const t = byId.get(type.toLowerCase())
            if (!t) return plural ? `${type}s` : type
            return plural ? (t.pluralName || `${t.name}s`) : t.name
        }
    }, [entityTypes])
}
