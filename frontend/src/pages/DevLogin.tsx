/**
 * Dev-Login page — only rendered when ``VITE_AUTH_CUSTOM_PROVIDER_ENABLED``
 * is set on the frontend. Drives the dev/demo Custom IdP at
 * ``/api/v1/auth/custom/*`` so JIT-provisioning + IdP-group reconciliation
 * can be exercised end-to-end without standing up a real OIDC/SAML IdP.
 *
 * Flow:
 *   1. User fills the form (email, names, external_id, claims JSON, groups).
 *   2. We POST to ``/api/v1/auth/custom/mock`` — the server HMAC-signs the
 *      payload into the ``nx_mock_identity`` cookie.
 *   3. We navigate to ``/api/v1/auth/custom/login?next=...`` which reads
 *      the cookie, runs ``complete_sso_login`` (find-or-provision + linking
 *      guardrails + group->role reconcile), sets the session cookies, then
 *      302s to ``next``.
 *
 * The page intentionally fails closed: if the env flag is off, it renders
 * a "feature disabled" banner instead of the form (matches the backend
 * 404 contract). Never ship the flag enabled in production.
 */
import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

const MOCK_URL = '/api/v1/auth/custom/mock'
const LOGIN_URL = '/api/v1/auth/custom/login'

interface MockPayload {
  external_id: string
  email: string
  first_name: string
  last_name: string
  claims: Record<string, unknown>
  groups: string[]
}

function readCsrfCookie(): string {
  if (typeof document === 'undefined') return ''
  const prefix = 'nx_csrf='
  for (const part of document.cookie.split(';')) {
    const t = part.trim()
    if (t.startsWith(prefix)) return decodeURIComponent(t.slice(prefix.length))
  }
  return ''
}

export function DevLogin() {
  const enabled = (import.meta.env.VITE_AUTH_CUSTOM_PROVIDER_ENABLED ?? '')
    .toString()
    .toLowerCase() === 'true'

  const [params] = useSearchParams()
  const navigate = useNavigate()
  const nextPath = useMemo(() => {
    const raw = params.get('next') ?? '/dashboard'
    return raw.startsWith('/') ? raw : '/dashboard'
  }, [params])

  useDocumentTitle('Dev sign in')

  const [externalId, setExternalId] = useState('S-1-5-21-1001')
  const [email, setEmail] = useState('alice@corp.example')
  const [firstName, setFirstName] = useState('Alice')
  const [lastName, setLastName] = useState('Doe')
  const [groupsText, setGroupsText] = useState('DataViz-Admins, Eng-All')
  const [claimsText, setClaimsText] = useState(
    JSON.stringify({ department: 'Eng', title: 'Staff Eng' }, null, 2),
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Don't even render the form when the feature flag is off — matches
  // the backend's 404 contract. Bounce to login to keep the URL space
  // tidy when someone navigates here in prod by accident.
  useEffect(() => {
    if (!enabled) {
      const t = setTimeout(() => navigate('/login', { replace: true }), 2000)
      return () => clearTimeout(t)
    }
  }, [enabled, navigate])

  if (!enabled) {
    return (
      <div className="min-h-screen w-screen flex items-center justify-center bg-canvas">
        <div className="max-w-md text-center p-8 rounded-2xl glass-panel">
          <h1 className="text-lg font-semibold mb-2 text-ink">Dev Login disabled</h1>
          <p className="text-sm text-ink-muted">
            Set <code>VITE_AUTH_CUSTOM_PROVIDER_ENABLED=true</code> and
            <code>AUTH_CUSTOM_PROVIDER_ENABLED=true</code> (backend) to
            enable the mock identity provider. Returning to login…
          </p>
        </div>
      </div>
    )
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    let claims: Record<string, unknown> = {}
    if (claimsText.trim()) {
      try {
        const parsed = JSON.parse(claimsText)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          claims = parsed as Record<string, unknown>
        } else {
          setError('claims must be a JSON object')
          return
        }
      } catch (err) {
        setError(`claims JSON parse failed: ${(err as Error).message}`)
        return
      }
    }

    const groups = groupsText
      .split(',')
      .map((g) => g.trim())
      .filter((g) => g.length > 0)

    const payload: MockPayload = {
      external_id: externalId.trim(),
      email: email.trim(),
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      claims,
      groups,
    }

    setSubmitting(true)
    try {
      const csrf = readCsrfCookie()
      const res = await fetch(MOCK_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        setError(`mock cookie set failed (${res.status})`)
        return
      }
      // Cookie is now planted. Navigate via window.location (NOT React
      // router) so the browser performs a full GET to the backend route,
      // which reads the cookie, completes the SSO login, sets session
      // cookies, and 302s us to ``next``.
      window.location.href = `${LOGIN_URL}?next=${encodeURIComponent(nextPath)}`
    } catch (err) {
      setError(`request failed: ${(err as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-canvas">
      <form
        onSubmit={onSubmit}
        className="glass-panel w-[480px] max-w-full p-8 rounded-2xl space-y-4"
      >
        <header className="space-y-1">
          <h1 className="text-xl font-semibold text-ink">Dev Login (mock IdP)</h1>
          <p className="text-xs text-ink-muted">
            Simulates an AD-style identity returning email, names, claims,
            and groups. The payload is HMAC-signed into a short-lived
            cookie, then handed to ``/auth/custom/login`` which runs JIT
            provisioning + group→role reconciliation.
          </p>
        </header>

        <label className="block text-sm">
          External ID (SID / NameID / sub)
          <input
            className="input mt-1 font-mono text-xs"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="block text-sm">
          Email
          <input
            type="email"
            className="input mt-1"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            First name
            <input
              className="input mt-1"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Last name
            <input
              className="input mt-1"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </label>
        </div>
        <label className="block text-sm">
          Groups (comma-separated)
          <input
            className="input mt-1 font-mono text-xs"
            value={groupsText}
            onChange={(e) => setGroupsText(e.target.value)}
            placeholder="DataViz-Admins, Eng-All"
          />
        </label>
        <label className="block text-sm">
          Claims (JSON object)
          <textarea
            className="input mt-1 font-mono text-xs"
            rows={6}
            value={claimsText}
            onChange={(e) => setClaimsText(e.target.value)}
          />
        </label>

        {error && (
          <div className="text-sm rounded-lg border border-accent-warning/40 bg-accent-warning/10 text-accent-warning p-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="btn btn-primary btn-md w-full"
        >
          {submitting ? 'Signing in…' : 'Sign in as mock user'}
        </button>
        <p className="text-[11px] text-ink-muted">
          next=<code>{nextPath}</code> · dev-only · refuses to load when
          AUTH_CUSTOM_PROVIDER_ENABLED is off.
        </p>
      </form>
    </div>
  )
}

export default DevLogin
