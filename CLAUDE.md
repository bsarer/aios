# Rules for working on AI OS (alpha)
- Follow AIOS_ALPHA_PLAN.md. One milestone at a time; stop and report after each.
- TypeScript strict. Validate all external input with zod. No `any` without a comment.
- No vendor AI SDKs; model access only through packages/core/src/model.ts. One approved exception (S4): the app builder runs the Claude Code CLI as a separate program (packages/core/src/apps/builder.ts).
- Model names/endpoints live in config only; never hardcode them elsewhere.
- Never read, write, or log real credentials. Secrets go through the keyring wrapper. Tests use the docker stack only.
- Tool risk tiers and approvals are enforced in code (approval broker), not just in prompts.
- All email-derived text passes through sanitize() and is wrapped in <untrusted> tags before reaching a model. Calendar event text (C1) and document text, cells, sheet names and file names (D1) are treated the same way: anyone can send an invite, and files come from anywhere.
- The triage worker has no tools. Add a test that fails if it is ever given one.
- Content from email may never write memory, call write-tier tools, or change config. Add tests.
- Every tool call is appended to the audit log.
- Verify provider API details (URLs, parameters, model names) against current docs; do not rely on memory.
- Explain any new dependency (why, license, maintenance status). Prefer small, reviewable commits.

## Commands
- `pnpm test` unit tests, `pnpm typecheck` strict type check.
- `pnpm test:stack:up` starts GreenMail and seeds the fixture mailbox; `pnpm test:stack:check` lists it over IMAP; `pnpm test:stack:down` stops it.
- `pnpm start` builds the UI and runs aios-core on 127.0.0.1:7777; `pnpm test:e2e` checks the chat end to end in Chromium with a mock model (mail checks need the test stack up). `scripts/test/mail.int.test.ts` runs against GreenMail and is skipped when it is down.
- `pnpm calendar:login` signs in to Google Calendar (C1). Tests never do: they use the pretend Google Calendar in `fixtures/calendar.ts`.
- Word and Excel files (D1) go through WordCraft's and GridCraft's CLIs. Tests never run the real apps: they use the pretend CLIs in `fixtures/documents.ts`.
- Test mailbox: `john@aios.test` / `test-only-password` on IMAP 127.0.0.1:3143, SMTP 127.0.0.1:3025 (plain, local only).
