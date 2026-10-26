# ProductSpy SaaS

Follow the root `AGENTS.md`, `docs/saas-requirements.md` and `docs/saas-plan.md`.
The official product is an online account-based SaaS with PostgreSQL; Windows/local-only behavior belongs to explicit legacy compatibility. All business queries require authenticated tenant context and server-side entitlements. Never substitute Mock/local tests for real cloud, AI, payment or cross-device acceptance.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
