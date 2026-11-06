<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## BBC platform development rules

- Preserve the modular monolith and typed business tables. `records` is only the scoped stable-identity index.
- Use server-side explicit business commands; no arbitrary state mutation endpoint or browser-provided actor/time.
- Every data path (including search, exports, worker and private files) must preserve scope and business-role checks.
- Never give technical admins implicit approval qualification or grant scope by task assignment.
- Keep applied SQL migrations immutable; add a new checksummed migration and adjust backup dependency order for new foreign keys.
- Update workflow tests when changing a gate; use `npm test`'s isolated native PostgreSQL harness, never a real database.
- Keep credentials, `.env*` (except example), runtime clusters, files and backups out of Git and release archives.
- No production deployment, destructive migration, external messages/signing/invitations or real inventory writes without applicable authorization.
- Treat all seeded data/rules as synthetic/sample. Do not claim formal validation or GLP/GMP/Part 11 compliance.
- Keep UI/business templates English; communicate implementation results to John in Chinese.
- Maintain concise architecture, operations and status documentation, including actual verification limits.
