/**
 * People — views a person created or last edited.
 *
 * It replaces the Creator dropdown: "who made this" is one question with a role
 * attached, so the role is a switch at the top of the same list rather than a
 * second list of the same people. The default matches either role. "Published"
 * — whoever last published the data behind the view — is a role you pick: a
 * publish stamps every view on the source, so counting it by default would hand
 * a person hundreds of views they never opened.
 *
 * "Edited" is the LATEST edit only; that is what each view records, and the
 * caption says so rather than letting the word promise a full history.
 *
 * You are pinned first, and stored as `me`, so a bookmarked "views I edited"
 * means the same to whoever opens it.
 */
import { useMemo } from 'react'
import { Check, UserCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { avatarPaletteFor } from '@/lib/avatar'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Segmented } from '@/components/ui/Segmented'
import { FilterDropdown, type FilterOption } from '@/components/explorer/FilterDropdown'
import { ME, type ContributorRole } from '../model'
import type { CurrentPerson, PersonOption } from '../people'

type RoleChoice = ContributorRole | 'any'

const ROLE_CAPTION: Record<RoleChoice, string> = {
  any: 'Views they created or last edited',
  created: 'Views they created',
  edited: 'Views they edited last — layout or settings',
  published: 'Views whose data they published last',
}

function countFor(p: PersonOption | undefined, role: RoleChoice): number {
  if (!p) return 0
  switch (role) {
    case 'created': return p.createdCount
    case 'edited': return p.editedCount
    case 'published': return p.publishedCount
    default: return p.count
  }
}

export function PeopleFilterMenu({ ids, role, people, currentUser, onChange }: {
  /** Selected user ids; may hold `ME`. */
  ids: string[]
  role: ContributorRole | null
  people: PersonOption[]
  currentUser: CurrentPerson | null
  onChange: (next: { ids: string[]; role: ContributorRole | null }) => void
}) {
  const roleChoice: RoleChoice = role ?? 'any'
  const byId = useMemo(() => new Map(people.map(p => [p.userId, p])), [people])
  const me = currentUser ? byId.get(currentUser.id) : undefined

  // Your own id selected directly (an old "created by" link) shows as You.
  const selected = useMemo(
    () => [...new Set(ids.map(id => (currentUser && id === currentUser.id ? ME : id)))],
    [ids, currentUser],
  )

  const options: FilterOption[] = useMemo(() => {
    const others = people
      .filter(p => p.userId !== currentUser?.id)
      .sort((a, b) => countFor(b, roleChoice) - countFor(a, roleChoice) || a.displayName.localeCompare(b.displayName))
      .map(p => ({ id: p.userId, label: p.displayName, sublabel: p.email ?? undefined }))
    // Someone already selected stays listed even if the facet no longer has them.
    const missing = selected
      .filter(id => id !== ME && !byId.has(id))
      .map(id => ({ id, label: id }))
    const you = currentUser
      ? [{ id: ME, label: 'You', sublabel: currentUser.name }]
      : []
    return [...you, ...missing, ...others]
  }, [people, currentUser, roleChoice, selected, byId])

  const personOf = (id: string): { userId: string | null; name: string; avatarId?: string | null } => {
    if (id === ME) return { userId: currentUser?.id ?? null, name: currentUser?.name ?? 'You', avatarId: currentUser?.avatarId ?? me?.avatarId }
    const p = byId.get(id)
    return { userId: id, name: p?.displayName ?? id, avatarId: p?.avatarId }
  }

  const stack = selected.slice(0, 3)

  return (
    <FilterDropdown
      icon={UserCircle}
      label="People"
      accent="rose"
      options={options}
      selectedIds={selected}
      onChange={next => onChange({ ids: next, role })}
      emptyMessage="Nobody has made a view you can see yet"
      searchPlaceholder="Search people…"
      panelWidthClassName="w-[22rem]"
      triggerPrefix={stack.length > 0 ? (
        <span className="flex -space-x-1.5" aria-hidden>
          {stack.map(id => {
            const p = personOf(id)
            return (
              <UserAvatar
                key={id}
                userId={p.userId}
                name={p.name}
                avatarId={p.avatarId}
                shape="palette"
                className="h-4 w-4 text-[7px] font-bold ring-2 ring-canvas"
              />
            )
          })}
        </span>
      ) : undefined}
      activeLabelFormatter={sel => {
        const first = personOf(sel[0])
        const name = sel[0] === ME ? 'You' : first.name
        const short = name.length > 16 ? `${name.slice(0, 15)}…` : name
        const who = sel.length === 1 ? short : `${short} +${sel.length - 1}`
        return role ? `${who} · ${role}` : who
      }}
      header={(
        <div className="border-b border-glass-border/50 px-3 pt-2.5 pb-2">
          <Segmented
            label="Which role"
            value={roleChoice}
            onChange={v => onChange({ ids, role: v === 'any' ? null : v })}
            options={[
              { value: 'any', label: 'Any' },
              { value: 'created', label: 'Created' },
              { value: 'edited', label: 'Edited' },
              { value: 'published', label: 'Published' },
            ]}
          />
          <p className="mt-1.5 text-[10px] text-ink-muted">{ROLE_CAPTION[roleChoice]}</p>
        </div>
      )}
      renderOption={(opt, { isSelected }) => {
        const p = personOf(opt.id)
        const count = opt.id === ME ? countFor(me, roleChoice) : countFor(byId.get(opt.id), roleChoice)
        const palette = avatarPaletteFor(p.userId ?? opt.id)
        return (
          <div className={cn('flex items-center gap-3 px-3 py-2', count === 0 && !isSelected && 'opacity-50')}>
            <UserAvatar
              userId={p.userId}
              name={p.name}
              avatarId={p.avatarId}
              shape="palette"
              className={cn(
                'w-8 h-8 text-[11px] font-bold transition-[box-shadow] duration-150',
                isSelected && cn('ring-2 ring-offset-1 ring-offset-canvas', palette.ring),
              )}
            />
            <div className="flex-1 min-w-0">
              <div className={cn('text-xs truncate text-ink', isSelected ? 'font-semibold' : 'font-medium')}>
                {opt.label}
              </div>
              {opt.sublabel && (
                <div className="text-[10px] text-ink-muted truncate">{opt.sublabel}</div>
              )}
            </div>
            <span
              className="inline-flex items-center rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-muted"
              aria-label={`${count} view${count === 1 ? '' : 's'}`}
            >
              {count}
            </span>
            {isSelected && <Check className="h-3.5 w-3.5 text-rose-500 shrink-0" />}
          </div>
        )
      }}
    />
  )
}
