# Campusly

Campusly is a school-focused collaboration platform with a GitHub-inspired dark interface, class channels, private direct messages, role-based access, moderation reports, and administrator audit logs.

## Current project structure

- `public/index.html` — responsive Campusly interface
- `src/index.js` — Cloudflare Worker API
- `schema.sql` — D1 database schema
- `wrangler.jsonc` — Worker, assets, and D1 configuration

## Roles

- **Student** — participate in classes and channels the account belongs to, use direct messages, and submit reports.
- **Teacher** — planned class-level management permissions; do not grant this role broader administrative access by default.
- **Moderator** — review safety reports.
- **Administrator** — manage roles, users, classes, channels, and audit logs.

All privileged endpoints must enforce authorization on the server. Hiding a button in the browser is not a security boundary.

## Before deployment

1. Create a Cloudflare D1 database named `campusly-db`.
2. Replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` in `wrangler.jsonc` with the database ID shown in Cloudflare.
3. Apply the schema: `npx wrangler d1 execute campusly-db --remote --file=./schema.sql`.
4. The D1 schema has already been created in the connected Cloudflare account for this project. For a new environment, apply it with `npx wrangler d1 execute campusly-db --remote --file=./schema.sql` or use the migration in `migrations/0001_initial.sql`.
5. Configure Worker secrets/variables:
   - `ADMIN_USERNAME` — initial administrator username (for example, `siteadmin`).
   - `CAMPUSLY_BOOTSTRAP_ADMIN_PASSWORD` — a new, unique password of at least 14 characters. Add it using `npx wrangler secret put CAMPUSLY_BOOTSTRAP_ADMIN_PASSWORD`; never put it in Git, source files, or a public dashboard.
6. `ADMIN_USERNAME` is already configured as `siteadmin` in `wrangler.jsonc`.
7. Install dependencies with `npm install`, then deploy with `npm run deploy`.
8. Visit the deployed Worker URL over HTTPS and test sign-in, logout, role checks, class enrollment, private messaging, and audit logging before inviting users.

The bootstrap routine creates the administrator only if that username does not already exist. Rotating the environment secret will not reset an existing account password. A separate, audited password-reset flow should be implemented before production use.

## Security notes

- Passwords are stored as PBKDF2-SHA-256 hashes with per-user salts.
- Sessions use random bearer tokens stored as SHA-256 hashes in D1 and are sent in Secure, HttpOnly, SameSite cookies.
- Do not store plaintext passwords, session tokens, or full private-message bodies in audit logs.
- Audit logs are designed to record event metadata; database administrators can still alter D1 data. Stronger tamper evidence requires exporting logs to a separately controlled destination.
- Failed-login events are logged. Add rate limiting, account lockout/backoff, monitoring, and recovery procedures before public deployment.
- Direct messages are restricted to conversation participants by the API. Administrators do not automatically receive access to message contents. If a school needs a safety review process, make it policy-based, narrowly scoped, disclosed to users, and audit every access.
- School use requires appropriate student privacy practices, data retention rules, consent/authorization, and careful handling of minors' information.
- This is a development starter, not a security-audited production service. Review and test before using real student data.

## Current implementation limits

This starter includes login/logout, session authentication, class-channel reading and messaging, direct messages, basic role changes, class/channel creation endpoints, reports, and audit-log viewing. Some UI management screens and advanced workflows remain to be completed. There is no end-to-end encryption, live WebSocket delivery, password-reset UI, email verification, invitation flow, or comprehensive rate limiting yet.

## Local development

Install a current Node.js LTS release, then:

```sh
npm install --save-dev wrangler
npx wrangler d1 create campusly-db
# Update database_id in wrangler.jsonc, then apply schema to the local DB:
npx wrangler d1 execute campusly-db --local --file=./schema.sql
npx wrangler dev
```

For local testing, set secrets with Wrangler's local secret workflow. Do not use real student information in development.
