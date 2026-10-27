# Campusly

Campusly is a school-focused collaboration platform with a GitHub-inspired dark interface, class channels, private direct messages, role-based access, moderation reports, and administrator audit logs.

## Project files

- `public/index.html` — responsive frontend
- `src/index.js` — Cloudflare Worker API
- `schema.sql` — D1 schema
- `migrations/0001_initial.sql` — initial D1 migration
- `wrangler.jsonc` — Worker, static assets, and D1 configuration
- `package.json` — local development and deployment scripts

## Roles

- **Student** — access classes/channels they are enrolled in, use private messages, and submit reports.
- **Teacher** — can be assigned as a class member; additional teacher-specific management features remain to be implemented.
- **Moderator** — intended for safety-report review; the API restricts report review access to moderators and administrators.
- **Administrator** — manage accounts, roles, classes, channels, enrollment, and audit logs.

Privileged actions are checked by the server, not merely hidden in the interface.

## Cloudflare setup

The connected Cloudflare account already has a D1 database named `campusly-db`, and the schema has been applied. The database ID is configured in `wrangler.jsonc`. For a new environment, create a D1 database and apply `schema.sql`:

```sh
npx wrangler d1 create campusly-db
# Replace database_id in wrangler.jsonc with the new database ID.
npx wrangler d1 execute campusly-db --remote --file=./schema.sql
```

The initial administrator username is configured as `siteadmin` in `wrangler.jsonc`. **Do not use the password previously shared in chat.** After deploying the Worker, set a new unique password of at least 14 characters as a Worker secret:

```sh
npm install
npm run deploy
npx wrangler secret put CAMPUSLY_BOOTSTRAP_ADMIN_PASSWORD
```

Enter the new password only at the Wrangler prompt. Never put it in source code, a GitHub file, or a commit. Then visit the deployed HTTPS site. The Worker creates the administrator account on the first request if the configured username does not already exist. If the account already exists, changing the secret does not reset its password.

## Security notes

- Passwords are stored as salted PBKDF2-SHA-256 hashes.
- Sessions use random tokens; only token hashes are stored in D1. Browser cookies are Secure, HttpOnly, and SameSite=Strict.
- Audit logs record metadata for logins, role/account changes, class/channel operations, message-sending events, reports, and administrative log access. Message bodies and passwords are not copied into audit records.
- Audit rows are protected from ordinary application-level editing, but a Cloudflare account/database administrator can still alter database contents. For stronger tamper evidence, export logs to a separately controlled destination.
- Direct messages are restricted to conversation participants. Administrators do not automatically get permission to read private-message contents.
- Rate limiting, email verification, password recovery, live WebSocket delivery, end-to-end encryption, advanced moderation workflows, and a full production security review are not yet implemented.
- This is a development starter, not a security-audited production service. Test with non-sensitive data before inviting students. School use requires appropriate privacy, retention, authorization, and safeguarding practices.

## Local development

Use a current Node.js LTS release:

```sh
npm install
npx wrangler dev
```

For a fresh local D1 database, apply the schema:

```sh
npx wrangler d1 execute campusly-db --local --file=./schema.sql
```

Do not use real student data in local development.
