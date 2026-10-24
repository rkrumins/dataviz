/** Builders for the data source transfer tests: a preview, a transfer, a destination. */
import type {
    DataSourceTransferResponse, TransferDestination, TransferIssue, TransferPreview, TransferSubject,
} from '@/services/dataSourceTransferService'

export const FINANCE = { id: 'ws_fin', name: 'Finance' }
export const RISK = { id: 'ws_risk', name: 'Risk' }

export function subject(over: Partial<TransferSubject> = {}): TransferSubject {
    return { type: 'user', id: 'usr_bob', name: 'Bob Ito', email: 'bob@example.com', role: 'Viewer', views: 2, via: 'app', ...over }
}

export function issue(over: Partial<TransferIssue> = {}): TransferIssue {
    return { code: 'aggregation_running', message: 'An aggregation run is in progress.', severity: 'blocker', transient: true, items: [], ...over }
}

export function preview(over: Partial<TransferPreview> = {}): TransferPreview {
    return {
        dataSource: { id: 'ds_orders', name: 'Orders', type: 'data_source' },
        fromWorkspace: FINANCE,
        toWorkspace: RISK,
        mode: 'direct',
        blockers: [],
        notes: [],
        views: [
            { id: 'v1', name: 'Revenue lineage', visibility: 'workspace', ownerName: 'Ana', trashed: false, followsDefault: false, publishRequested: false },
            { id: 'v2', name: 'Old draft', visibility: 'private', ownerName: 'Ana', trashed: true, followsDefault: false, publishRequested: false },
        ],
        viewCounts: { total: 2, trashed: 1, followsDefault: 0, private: 0, workspace: 1, enterprise: 0, publishRequested: 0 },
        access: {
            creators: 1, sharedWith: 0, everyone: 0, gainsPeople: 12, gainsViews: 1, adminViews: 0,
            requestPolicy: 'approval',
            loses: [
                subject({ type: 'group', id: 'grp_analysts', name: 'Analysts', email: null, memberCount: 5, role: 'Viewer', views: 1, via: 'group' }),
                subject(),
            ],
        },
        versioning: { commits: 14, openDrafts: 1, openReviews: 0, forks: 0 },
        primary: { wasPrimary: false, wasDefault: false, becomesPrimary: false, pinsDestinationDefault: null },
        identity: null,
        token: 'tok_1',
        ...over,
    }
}

export function transfer(over: Partial<DataSourceTransferResponse> = {}): DataSourceTransferResponse {
    return {
        id: 'xfer_1',
        kind: 'move',
        status: 'completed',
        dataSource: { id: 'ds_orders', name: 'Orders', type: 'data_source' },
        fromWorkspace: FINANCE,
        toWorkspace: RISK,
        createdBy: { id: 'usr_ana', name: 'Ana Admin' },
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        reason: null,
        expiresAt: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        completedAt: new Date(Date.now() - 3_600_000).toISOString(),
        undoneBy: null,
        undoneAt: null,
        viewCount: 2,
        lostAccess: { people: 1, groups: 1 },
        undoUntil: new Date(Date.now() + 6 * 86_400_000).toISOString(),
        canAccept: false,
        canDecline: false,
        canCancel: false,
        canUndo: true,
        undoBlockedBy: null,
        ...over,
    }
}

export function request(over: Partial<DataSourceTransferResponse> = {}): DataSourceTransferResponse {
    return transfer({
        kind: 'request',
        status: 'pending',
        completedAt: null,
        undoUntil: null,
        canUndo: false,
        expiresAt: new Date(Date.now() + 13 * 86_400_000).toISOString(),
        reason: 'Risk owns this now',
        ...over,
    })
}

export function destination(over: Partial<TransferDestination> = {}): TransferDestination {
    return { id: RISK.id, name: RISK.name, description: 'Risk models', dataSourceCount: 3, mode: 'direct', reason: null, ...over }
}
