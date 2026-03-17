# Sign-up and User Service — Implementation Plan (Revised)

**Design principles (holistic).** This plan treats the feature as one system: **auditability and safe evolution** (database), **clarity and trust** (UI/UX), **predictable behavior and operability** (engineering), **growth without rewrites** (scalability), and **defense in depth** (security). The revised version enforces a **logical split** so the User Service can be cut and pasted into its own repository and database without breaking the main application.

---

## 1. Current State

- **Auth:** Client-only in `frontend/src/store/auth.ts` — env-based username/password hash (SHA-256), no backend auth API.
- **Backend:** FastAPI at `/api/v1`, async SQLAlchemy in `backend/app/db/models.py`, repos + Pydantic in `backend/common/models/management.py`. `ViewFavouriteORM` has `user_id` (Text) with no FK; views endpoints use `_PLACEHOLDER_USER`.
- **Login UI:** `frontend/src/components/auth/LoginPage.tsx` — glass panel, motion, shared CSS (`input`, `glass-panel`, `gradient-text` in `frontend/src/styles/globals.css`).

---

## 2. Architectural Strategy: "The Logical Split"

**Goal:** Ensure the User Service can be cut and pasted into its own repository/database without breaking the main application.

- **Domain isolation:** All user-related logic lives in `backend/app/users/`. No user tables or user business logic in the rest of the app.
- **Zero physical FKs:** Cross-domain tables (e.g. `view_favourites`) store `user_id` as a **logical reference** (UUID v7) only. There is **no database-level foreign key** from `view_favourites.user_id` to `users.id`. This allows the `users` schema to live in a separate database when the User Service is extracted.
- **Event-driven hooks:** The system uses a **Transactional Outbox** pattern. When a user is created or approved, a row is written to `outbox_events` in the same transaction. A processor (same process or separate worker) reads unprocessed events and publishes to a message bus (or in-memory in v1). Other parts of the system react to `user.created` and `user.approved` via events, not by querying the user DB. **Outbox consumer:** In the monolith, a background task reads `outbox_events` where `processed = false`, publishes to the chosen destination (NATS / RabbitMQ / or in-memory for v1), then sets `processed = true`. When the User Service is split, this processor runs inside the User Service and publishes to the shared message bus.

---

## 3. Database Schema: High-Performance & Sortable

**Principle:** Use **UUID v7** for primary keys. Time-ordered IDs reduce index fragmentation and allow efficient sorting by creation time.

**Database choice:**  
- **Option A (same DB):** User tables live in the existing management DB (SQLite in dev). Use TEXT for UUIDs, TEXT for timestamps (ISO UTC), and a TEXT column storing JSON for `metadata` (SQLite has no native `jsonb`). Indexes and partial indexes still apply where the engine supports them.  
- **Option B (separate DB from day one):** User domain uses its own database (e.g. PostgreSQL). Use native `uuid` (or uuid_v7), `timestamptz`, and `jsonb`; GIN index on `metadata`, partial index on `users(id) WHERE status = 'pending'`.  
State the chosen option in implementation; the schema below is described in a DB-agnostic way with type hints.

### 3.1 Entity relationship (domain-isolated)

```mermaid
erDiagram
    users {
        uuid_v7 id PK
        text email UK "Indexed (lower-case)"
        text password_hash "Argon2id"
        text first_name
        text last_name
        text status "pending | active | suspended"
        text auth_provider "local | saml2 | oidc"
        text external_id "SSO subject"
        text metadata "JSON: SSO claims, preferences"
        timestamp_tz created_at
        timestamp_tz updated_at
        timestamp_tz deleted_at "Soft delete, Right to be Forgotten"
    }

    user_roles {
        uuid_v7 id PK
        uuid_v7 user_id "Logical reference, no FK"
        text role_name "admin | user | viewer"
        timestamp_tz created_at
    }

    user_approvals {
        uuid_v7 id PK
        uuid_v7 user_id "Logical reference"
        uuid_v7 approved_by "Logical reference"
        text status "pending | approved | rejected"
        timestamp_tz created_at
        timestamp_tz resolved_at
    }

    outbox_events {
        uuid_v7 id PK
        text event_type "user.created | user.approved"
        text payload "JSON"
        timestamp_tz created_at
        boolean processed "default false"
    }

    users ||--o{ user_roles : has
    users ||--o{ user_approvals : "approval record"
```

- **users:** Core profile. `status`: `pending` (awaiting approval), `active`, `suspended`. `auth_provider` + `external_id` for SSO; local signup uses `local`. `metadata`: JSON for SSO claims and preferences (no schema churn for new attributes). `deleted_at`: set for "Right to be Forgotten"; exclude from default queries, keep for audit.
- **user_roles:** One row per (user, role). `role_name` is `admin` | `user` | `viewer` (no separate `roles` table in v1; add a `roles` table later if many roles or permission inheritance is needed). `user_id` is a logical reference only (no FK to `users` if user table moves to another DB—within the same DB, FK is optional for integrity; when splitting, drop FK).
- **user_approvals:** Audit trail; `user_id` and `approved_by` are logical references. Single source of truth for "who approved when."
- **outbox_events:** Event type, JSON payload, `processed` flag. Same transaction as user create/approve; processor publishes and marks processed.

**Cross-domain (e.g. view_favourites):** `user_id` remains a UUID v7 value (same type as `users.id`). **No foreign key** from `view_favourites.user_id` to `users.id`. Application logic resolves "current user" from JWT and passes `user_id`; no referential integrity across domains.

### 3.2 Database best practices (applied)

- **Indexes:** Unique on `users.email` (store and index lower-cased, or use collation where supported). Non-unique on `users(status, created_at)` for admin lists. **Partial index:** `users(id) WHERE status = 'pending'` (or equivalent) so the Admin "pending signups" list is fast even with millions of users. Indexes on `user_roles(user_id)`, `user_roles(role_name)`; on `user_approvals(user_id, status)` and `status`; on `outbox_events(processed, created_at)` for the processor.
- **GIN index:** On `users.metadata` where the engine supports it (e.g. PostgreSQL jsonb) for querying custom attributes.
- **Soft deletes:** `users.deleted_at`; default queries filter `WHERE deleted_at IS NULL`; supports "Right to be Forgotten" without destroying audit history.
- **Timestamps:** Store in UTC (`timestamptz` or ISO string in TEXT); app converts for display.

---

## 4. Backend: Engineering & Security Excellence

**Principles:** API-first contract, validation at the boundary, no secrets in logs, idempotent signup, stateless auth.

### 4.1 Module layout (microservice-ready)

```
backend/app/users/
├── api/             # FastAPI routers (the contract)
├── core/             # Hashing (Argon2id), JWT logic, password policy
├── models/           # SQLAlchemy ORM (domain-specific tables only)
├── repositories/     # Pure DB operations (atomic, no business logic)
├── services/         # Business logic, outbox event writing
└── schemas/          # Pydantic DTOs (request/response, the interface)
```

Routers in `api/` depend on `services/` and `schemas/`; services use `repositories/` and `core/` (hashing, JWT). When the User Service is extracted, this tree moves as-is (or to a new repo).

### 4.2 Advanced auth contract

- **Hashing:** Argon2id (OWASP-recommended). Server-side only; frontend sends password over HTTPS.
- **Stateless JWTs:** Tokens include `user_id`, `email`, and `roles`. Other services can verify the JWT signature locally without calling the User Service. Short-lived access token; define expiry; optional refresh with rotation later.
- **Idempotency:** `POST /api/v1/auth/signup` supports an **`X-Idempotency-Key`** header. Same key within a time window returns the same response (e.g. 201 with same user or 409 if already exists); prevents duplicate accounts on double-click or retries.
- **Constant-time verification:** Password comparison must be constant-time to prevent timing attacks (use the library’s secure compare).

### 4.3 API endpoints

- **Public:** `POST /api/v1/auth/signup` (SignUpRequest → SignUpResponse; "pending approval"; idempotency key); `POST /api/v1/auth/login` (LoginRequest → LoginResponse with user profile + JWT).
- **Authenticated:** `GET /api/v1/users/me`, optional `PATCH /api/v1/users/me`. All require `Authorization: Bearer <token>`.
- **Admin:** `GET /api/v1/admin/users` (filter by status, **paginated**—see Scalability); `POST /api/v1/admin/users/{user_id}/approve`, optional reject. Gated by "admin" role in JWT and enforced in backend dependency.

### 4.4 Security and operability

- **Credential masking:** Middleware strips `password` and `password_hash` from all JSON request/response logs. Never log secrets.
- **Logging:** Log only safe identifiers (user id, masked email) and event type (signup, login success/failure, approval).
- **Validation:** Pydantic for all inputs (email format, password policy, name length); 422 with clear messages.
- **Error contract:** Consistent JSON (`detail`, optional `code` e.g. `DUPLICATE_EMAIL`) for client handling.
- **Login enumeration:** Single generic message ("Invalid email or password") and similar response time.
- **Admin:** Approve/reject only if JWT contains admin role; enforce in dependency.

---

## 5. Frontend: Resilient & Transparent UX

**Principles:** Match LoginPage aesthetic (glass, motion, typography); accessible, clear feedback, secure storage.

### 5.1 Sign-up page

- **Component:** `frontend/src/components/auth/SignUpPage.tsx`.
- **Visual:** Same as LoginPage: glass panel, motion, shared `input`/labels. Fields: First Name, Last Name, Email, Password, optional Confirm Password.
- **Password strength:** Use **zxcvbn** (or equivalent) for real-time "time to crack" / strength meter instead of only "min 8 chars."
- **Submit:** `POST /api/v1/auth/signup` with optional `X-Idempotency-Key` (e.g. from a generated client key). Success: “Account created. An administrator will approve your request shortly.”
- **Optimistic error handling:** If the API returns duplicate email (409 or equivalent), show a clear message and immediately offer a **"Forgot password?"** (or "Reset password") path instead of only a generic error.
- **Focus management:** After successful signup, move keyboard focus to the success message (e.g. "Check your email" / "Pending approval") for screen-reader users.
- **SSO:** Disabled button with "Coming Soon" and subtle warning styling; same on LoginPage.

### 5.2 Login page

- **Flow:** "Create account" link to SignUp; same SSO "Coming Soon" button. Login calls `POST /api/v1/auth/login`; store JWT and user in auth store.
- **Auth store:** Signup action; login calls backend; store **JWT in sessionStorage** (not localStorage) to mitigate XSS exposure (sessionStorage is tab-scoped and not persisted across tabs). Store `user.id` for view_favourites and future RBAC.
- **Accessibility:** Labels, focus ring, errors linked via `aria-describedby`; loading state and disabled submit during request.

### 5.3 General UX

- **Validation:** Inline email format, password strength (zxcvbn), confirm password match; disable submit while loading.
- **Responsive:** Single column, touch-friendly; consistent with LoginPage.

---

## 6. Admin Approval Flow

- **On signup:** Create user with `status = 'pending'`; insert into `user_approvals` with status `pending`; write `user.created` to `outbox_events`. Do not assign `user` role yet.
- **Admin:** User with role `admin` sees "Pending signups." List via `GET /api/v1/admin/users?status=pending` (paginated). Approve → `POST .../approve`: set user `status = 'active'`, add `user_roles` row with `role_name = 'user'`, update `user_approvals` (resolved_at, approved_by), write `user.approved` to `outbox_events`.
- **Login:** Backend allows login only when `status = 'active'` and `deleted_at IS NULL`; otherwise 403 with "Your account is pending approval" or "Account deactivated."

---

## 7. Scalability & Operational Readiness

| Concern | Monolith (current) | Microservice (future) |
|--------|---------------------|------------------------|
| **Communication** | Direct function calls within app | Message bus (e.g. RabbitMQ / NATS) for user.created / user.approved |
| **Data integrity** | DB transactions (user + outbox in one tx) | Saga pattern (distributed transactions) if needed |
| **Pagination** | `OFFSET` / `LIMIT` for admin user list | Prefer **keyset (cursor-based)** pagination for large datasets |
| **Auth** | Shared middleware; JWT verified in app | Sidecar auth (e.g. Envoy / Istio) or API gateway validates JWT |

- **Stateless auth:** JWT in header; no server-side session store; horizontal scaling and future gateway/User Service.
- **Rate limiting:** Implement **Leaky Bucket** (or equivalent) at API gateway level—e.g. **5 signups per IP per hour**, and limits on login attempts. Protects signup and login from abuse.

---

## 8. Security Summary (Defense in Depth)

- **Credentials:** Passwords only in request body over HTTPS; never in URL, query, or logs. Server hashes (Argon2id) and compares with constant-time verification.
- **Credential masking:** Middleware strips `password` and `password_hash` from all JSON logs.
- **Rate limiting:** Leaky bucket at gateway (e.g. 5 signups per IP per hour).
- **Constant-time comparison:** Used for password verification to prevent timing attacks.
- **Admin:** Approve/reject gated by backend role check (JWT).
- **Tokens:** Short-lived JWT; stored in sessionStorage on client; no sensitive data in payload beyond what’s needed (user_id, email, roles).
- **Headers:** `Authorization: Bearer <token>`; keep `X-Request-ID` for tracing.

---

## 9. Implementation Order

1. **Backend — DB and domain**
   - Add ORM models: `users` (UUID v7 id, email, password_hash, first_name, last_name, status, auth_provider, external_id, metadata, created_at, updated_at, deleted_at), `user_roles`, `user_approvals`, `outbox_events`. Use logical references only; no FK from other domains to `users`.
   - Migrations: create tables; indexes (unique email, status+created_at, partial index WHERE status = 'pending'); GIN on metadata if supported.
   - Choose DB: same DB (SQLite-friendly types) or separate DB (PostgreSQL with timestamptz/jsonb).

2. **Backend — users module**
   - Create `backend/app/users/` with `api/`, `core/`, `models/`, `repositories/`, `services/`, `schemas/`.
   - Implement Argon2id hashing and JWT (issue and verify) in `core/`; password policy in Pydantic/schemas.
   - Repositories: atomic CRUD for users, user_roles, user_approvals, outbox_events.
   - Services: signup (create user + approval + outbox row), login (verify password, require active, issue JWT), approve (update user, add role, approval record, outbox row). Outbox processor: background task that reads unprocessed `outbox_events`, publishes, marks processed.
   - API: signup (with X-Idempotency-Key), login, GET/PATCH /users/me, GET /admin/users (paginated), POST /admin/users/{id}/approve (and optional reject). Middleware: strip password/password_hash from logs; constant-time password compare in login.

3. **Backend — wiring**
   - Register routers under `/api/v1/auth` and `/api/v1/users`, `/api/v1/admin/users`. Add JWT dependency for protected routes and admin-only dependency for approval endpoints. Start outbox processor (same process or worker).

4. **Frontend — sign-up and login**
   - SignUp page: form (first name, last name, email, password, confirm); zxcvbn strength meter; submit with optional idempotency key; on duplicate email, show message + "Forgot password?"; on success, focus success message; SSO "Coming Soon" disabled button.
   - Login page: "Create account" link; SSO "Coming Soon"; call backend login; store JWT in sessionStorage and user in auth store.
   - Auth store: signup action, login calling backend, store user.id and token; use token in API requests (Authorization header).

5. **Admin**
   - "Pending signups" (or "User management") in existing Admin area: list from GET /admin/users?status=pending (paginated); Approve/Reject buttons calling new admin endpoints.

6. **Optional follow-ups**
   - Rate limiting at gateway (leaky bucket, 5 signups per IP per hour).
   - Keyset pagination for GET /admin/users when dataset is large.
   - Forgot password flow (separate plan).

---

## 10. Best Practices — Cross-Cutting Summary

| Area | Principle | Applied in this plan |
|------|-----------|----------------------|
| **Architecture** | Logical split, no cross-domain FKs | Domain isolation in `users/`; `user_id` as UUID only in view_favourites; outbox for events. |
| **DB** | Auditability, performance, soft delete | UUID v7; partial index for pending; GIN on metadata; deleted_at; outbox_events. |
| **UI/UX** | Clarity, trust, accessibility | zxcvbn; duplicate email → Forgot password; sessionStorage; focus management; labels, focus, errors. |
| **Engineering** | Predictable, operable | Idempotency key; Pydantic validation; consistent error contract; credential masking in logs. |
| **Scalability** | Stateless, paginated, rate-limited | JWT; pagination (cursor later); rate limit at gateway; outbox for async decoupling. |
| **Security** | Defense in depth | Argon2id; constant-time compare; credential stripping; leaky bucket; server-side admin check. |

This document is the single source of truth for sign-up and User Service: schema, APIs, UX, and practices are aligned for production and for cutting the User Service into its own repository and database when needed.
