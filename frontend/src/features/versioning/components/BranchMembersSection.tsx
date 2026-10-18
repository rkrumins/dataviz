/**
 * BranchMembersSection — who else can see or change a draft, inside BranchSettingsModal. The owner
 * and maintainers change roles, remove and add people or groups; everyone else reads the list.
 */
import { Eye, Loader2, Pencil, ShieldCheck, Trash2, Users2 } from 'lucide-react'
import { useAppNotifications } from '@/components/ui/notifications'
import { Segmented } from '@/components/ui/Segmented'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { AddGrantPicker, type SubjectType } from '@/components/access/AddGrantPicker'
import type { BranchMember, BranchMembersResponse, DraftRole } from '@/services/versioningApiService'
import { useAddBranchMember, useRemoveBranchMember } from '../hooks/useVersioning'

const DRAFT_ROLES: { id: DraftRole; label: string; icon: typeof Eye }[] = [
  { id: 'viewer', label: 'Viewer', icon: Eye },
  { id: 'editor', label: 'Editor', icon: Pencil },
  { id: 'maintainer', label: 'Maintainer', icon: ShieldCheck },
]

export function BranchMembersSection({
  wsId,
  graphId,
  branchId,
  members,
  myRole,
  onAdded,
}: {
  wsId: string
  graphId: string
  branchId: string
  /** Undefined while loading. */
  members?: BranchMember[]
  myRole?: BranchMembersResponse['myRole']
  /** A member was added — which also makes a private draft shared. */
  onAdded: () => void
}) {
  const { notify } = useAppNotifications()
  const add = useAddBranchMember(wsId, graphId, branchId)
  const remove = useRemoveBranchMember(wsId, graphId, branchId)
  const canManage = myRole === 'owner' || myRole === 'maintainer'
  const onError = (e: unknown) => notify('error', (e as Error).message)

  const addMember = async (subjectType: SubjectType, subjectId: string, role: DraftRole) => {
    try {
      await add.mutateAsync({ subjectType, subjectId, role })
      onAdded()
    } catch (e) {
      onError(e)
    }
  }

  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80 mb-1.5">Members</label>
      {members === undefined ? (
        <div className="flex items-center justify-center py-4 text-ink-muted text-xs">
          <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Loading members…
        </div>
      ) : members.length === 0 ? (
        <p className="rounded-lg border border-dashed border-glass-border px-3 py-3 text-center text-xs text-ink-muted">
          Only you can see this draft
        </p>
      ) : (
        <div className="rounded-lg border border-glass-border divide-y divide-glass-border">
          {members.map((m) => {
            const name = m.name ?? m.subjectId
            return (
              <div key={`${m.subjectType}:${m.subjectId}`} className="flex items-center gap-2.5 px-3 py-2">
                {m.subjectType === 'user' ? (
                  <UserAvatar userId={m.subjectId} name={name} shape="gradient" className="w-7 h-7 text-[10px] font-bold" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0">
                    <Users2 className="w-3.5 h-3.5" />
                  </div>
                )}
                <p className="min-w-0 flex-1 text-sm text-ink truncate">{name}</p>
                {canManage ? (
                  <>
                    <Segmented
                      label={`Role of ${name}`}
                      value={m.role}
                      options={DRAFT_ROLES.map(({ id, label }) => ({ value: id, label }))}
                      onChange={(role) => add.mutate({ subjectType: m.subjectType, subjectId: m.subjectId, role }, { onError })}
                    />
                    <button
                      onClick={() => remove.mutate({ subjectType: m.subjectType, subjectId: m.subjectId }, { onError })}
                      disabled={remove.isPending}
                      aria-label={`Remove ${name}`}
                      title={`Remove ${name}`}
                      className="p-1.5 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                ) : (
                  <span className="text-[11px] font-medium text-ink-muted shrink-0">
                    {DRAFT_ROLES.find((r) => r.id === m.role)?.label ?? m.role}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
      {canManage && (
        <div className="mt-2">
          <AddGrantPicker disabled={add.isPending} onAdd={addMember} roles={DRAFT_ROLES} defaultRole="editor" />
        </div>
      )}
      <p className="text-[10px] text-ink-muted/70 mt-1">
        People added through a group also need edit access to this data source to make changes.
      </p>
    </div>
  )
}
