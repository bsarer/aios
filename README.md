# AI OS (alpha)

A full-screen chat that acts as the desktop on Omarchy. See [AIOS_ALPHA_PLAN.md](AIOS_ALPHA_PLAN.md) for the plan and [CLAUDE.md](CLAUDE.md) for working rules.

## Status

A0 (repo, rules, test mail) is done. A1 (model adapter and bake-off) is built; the bake-off runs on your machine with `pnpm bakeoff`, see [evals/README.md](evals/README.md).

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
```

To look at the seeded mail in a regular client (Thunderbird, aerc, mutt), add an account with
IMAP `127.0.0.1:3143`, SMTP `127.0.0.1:3025`, no TLS, user `john@aios.test`, password `test-only-password`.

## Layout

```
packages/shared   config schema (zod) and TOML parsing
packages/core     daemon: model adapter (model.ts), keyring wrapper, tool definitions, sanitize(), prompts
packages/ui       React chat UI (A2)
scripts           setup/uninstall CLI, mail seeder and checker
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
