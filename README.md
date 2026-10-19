# AI OS (alpha)

A full-screen chat that acts as the desktop on Omarchy. See [AIOS_ALPHA_PLAN.md](AIOS_ALPHA_PLAN.md) for the plan and [CLAUDE.md](CLAUDE.md) for working rules.

## Status

A0 (repo, rules, test mail), A1 (model adapter and bake-off, default model Claude Haiku 5.5), A2 (chat UI and core shell) and A3 (memory) are merged. A4 (mail reading, watcher and triage) is in review.

## Mail

- **Ask about mail:** "anything from Sara this week?" uses `mail_search`, `mail_read` and `mail_thread` over INBOX and Sent. They are read-only, and every result reaches the model sanitized and wrapped in `<untrusted>` tags.
- **New mail:** an IDLE connection (plus a poll every `[mail] pollIntervalSeconds`, default 30) queues new INBOX messages in SQLite, keyed by Message-ID. Reconnects and server restarts cause no duplicates or gaps. The first run starts from "now" rather than triaging the existing mailbox.
- **Triage:** after a short batch window (`batchWindowSeconds`, default 20), one model call with no tools classifies the batch. One notification follows: urgent mail first, low-priority mail in a digest line, with Read and Ignore buttons. Draft reply arrives in A5.
- **Holding mail back:** while paused, during `[notifications] quietHours`, or over `maxPerHour` (default 6), mail is held and posted later as one "While you were away" catch-up. When the model is down, it retries every minute. After 5 failed attempts the mail is posted with a plain summary instead of being dropped.
- **Chat context:** new-mail summaries are not added to the model's chat context. They come from email, and would put untrusted text in front of every turn. The model looks mail up with the tools instead.

## Memory

Long-term memory is plain Markdown you own, in `~/.config/aios/memory/`:

- `profile.md`: name, role, preferences and standing instructions. Always in context. Edit it by hand any time.
- `facts.md`: one `- fact` per line, each saved only after you click **Save** on a "Remember this?" card.
- `summaries/YYYY-MM-DD.md`: written after 03:00 (`[memory] nightlyAt`) from the previous day's chat. Tool results and email bodies are never included.

Chat commands: `/remember <text>` offers a card directly, `/memory` shows everything, `/forget <text>` removes a fact, `/export` writes one Markdown file with all of it.
A suggestion made while email text was in the model's context is labelled as such on its card. Nothing is written without a click.
Each chat request fits a token budget (`[memory] contextTokens`, default 8000): the system prompt, the profile, recalled facts and summaries (SQLite FTS5), then as many recent turns as fit.

## Quick start

Needs Node 22+, pnpm 10, Docker with compose, and `secret-tool` (libsecret) for `setup`.

```sh
pnpm install
pnpm test                 # unit tests
pnpm typecheck            # strict TypeScript
pnpm test:stack:up        # start GreenMail on 127.0.0.1 and seed 40 fixture emails
pnpm test:stack:check     # list the mailbox over IMAP
pnpm run setup --dry-run  # walk through setup without touching keyring or disk
pnpm test:stack:down
pnpm start                # build the UI and start aios-core on http://127.0.0.1:7777 (needs `pnpm run setup`)
pnpm test:e2e             # drive the chat in Chromium against a mock model (CHROMIUM_PATH if not on PATH); mail checks run when the test stack is up
```

`better-sqlite3` compiles a native module on install; on Omarchy that needs `base-devel` (usually already present).

To look at the seeded mail in a regular client (Thunderbird, aerc, mutt), add an account with
IMAP `127.0.0.1:3143`, SMTP `127.0.0.1:3025`, no TLS, user `john@aios.test`, password `test-only-password`.

## Layout

```
packages/shared   config schema (zod) and TOML parsing
packages/core     daemon: agent loop, Fastify/WebSocket server, SQLite store, memory, audit log, model adapter, keyring, tools
packages/ui       React chat UI (Vite + Tailwind): streaming chat, status strip
scripts           setup/uninstall CLI, mail seeder and checker, browser e2e check
fixtures/mail.ts  40 sample emails: threads, attachments, 6 hostile samples
evals             model bake-off: tasks, runner, report
```

## Dependencies added in A0

| Package | Why | License | Maintenance |
|---|---|---|---|
| zod | validate config and all external input | MIT | very active |
| smol-toml | parse and write `config.toml`, zero deps | BSD-3-Clause | active |
| imapflow | IMAP client for seeding, checks and later the watcher | MIT | active (Postal Systems) |
| nodemailer | builds RFC 822 fixtures now, SMTP send in A5; ships its own types | MIT-0 | very active |
| tsx | run TypeScript scripts without a build step (dev) | MIT | active |
| vitest, typescript | tests and type checking (dev) | MIT, Apache-2.0 | very active |

## Dependencies added in A2

| Package | Why | License | Maintenance |
|---|---|---|---|
| fastify, @fastify/websocket, @fastify/static | HTTP + WebSocket server for the UI | MIT | very active |
| better-sqlite3 | short-term store (history, turns, usage, settings); synchronous and fast | MIT | active |
| react, react-dom | chat UI | MIT | very active |
| react-markdown | renders assistant replies; never renders raw HTML, which matters when replies quote email | MIT | active |
| vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite | UI build and styling (dev) | MIT | very active |
| ws | WebSocket client for server tests (dev) | MIT | very active |
| playwright-core | drives the system Chromium for `pnpm test:e2e`; downloads no browsers (dev) | Apache-2.0 | very active |

## Dependencies added in A4

| Package | Why | License | Maintenance |
|---|---|---|---|
| imapflow (in core; already used by scripts since A0) | IMAP for the mail tools and the IDLE watcher; decodes MIME parts, so no separate mail parser is needed | MIT | very active (same author as nodemailer) |
