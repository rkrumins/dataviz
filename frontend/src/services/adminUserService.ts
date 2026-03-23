/**
 * Admin User Service — manage user accounts, roles, and approvals.
 */
import { authFetch } from './apiClient'

const ADMIN_USERS_API = '/api/v1/admin/users'

export interface AdminUserResponse {
    id: string
    email: string
    firstName: string
    lastName: string
    displayName: string
    status: string
    role: string
    createdAt: string
    updatedAt: string
    resetRequested: boolean
}

export interface ResetTokenResponse {
    resetToken: string
    expiresAt: string
}

export const adminUserService = {
    listUsers(status?: string): Promise<AdminUserResponse[]> {
        const params = status ? `?status=${encodeURIComponent(status)}` : ''
        return authFetch<AdminUserResponse[]>(`${ADMIN_USERS_API}${params}`)
    },

    approveUser(userId: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/approve`, {
            method: 'POST',
        })
    },

    rejectUser(userId: string, rejectionReason?: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/reject`, {
            method: 'POST',
            body: JSON.stringify({ rejectionReason: rejectionReason || null }),
        })
    },

    changeRole(userId: string, role: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/role`, {
            method: 'PUT',
            body: JSON.stringify({ role }),
        })
    },

    suspendUser(userId: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/suspend`, {
            method: 'POST',
        })
    },

    reactivateUser(userId: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/reactivate`, {
            method: 'POST',
        })
    },

    resetPassword(userId: string, newPassword: string): Promise<{ detail: string }> {
        return authFetch<{ detail: string }>(`${ADMIN_USERS_API}/${userId}/reset-password`, {
            method: 'POST',
            body: JSON.stringify({ newPassword }),
        })
    },

    generateResetToken(userId: string): Promise<ResetTokenResponse> {
        return authFetch<ResetTokenResponse>(`${ADMIN_USERS_API}/${userId}/generate-reset-token`, {
            method: 'POST',
        })
    },
}
