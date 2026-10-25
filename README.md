# AI OS (alpha)

A full-screen chat that acts as the desktop on Omarchy. See [AIOS_ALPHA_PLAN.md](AIOS_ALPHA_PLAN.md) for the plan and [CLAUDE.md](CLAUDE.md) for working rules.

## Status

A0 (repo, rules, test mail), A1 (model adapter and bake-off, default model Claude Haiku 5.5), A2 (chat UI and core shell), A3 (memory), A4 (mail reading, watcher and triage), A5 (replies and approvals), A6 (kiosk) and A7 (hardening) are merged. S1 (system controls) is in review.

## Mail

- **Ask about mail:** "anything from Sara this week?" uses `mail_search`, `mail_read` and `mail_thread` over INBOX and Sent. They are read-only, and every result reaches the model sanitized and wrapped in `<untrusted>` tags.
- **New mail:** an IDLE connection (plus a poll every `[mail] pollIntervalSeconds`, default 30) queues new INBOX messages in SQLite, keyed by Message-ID. Reconnects and server restarts cause no duplicates or gaps. The first run starts from "now" rather than triaging the existing mailbox.
- **Triage:** after a short batch window (`batchWindowSeconds`, default 20), one model call with no tools classifies the batch. One notification follows: urgent mail first, low-priority mail in a digest line, with Read, Draft reply and Ignore buttons.
- **Holding mail back:** while paused, during `[notifications] quietHours`, or over `maxPerHour` (default 6), mail is held and posted later as one "While you were away" catch-up. When the model is down, it retries every minute. After 5 failed attempts the mail is posted with a plain summary instead of being dropped.
- **Replying:** "reply to Sara saying Thursday works" (or **Draft reply** on a notification) saves a draft to your Drafts folder and shows it as a card with **Send**, **Edit** and **Discard**. Nothing is sent until you click Send. The click carries a hash of exactly what the card shows, and only that text is sent, once, over SMTP. Editing gives the draft a new hash, so an earlier approval no longer matches. Discard deletes the draft and sends nothing. After sending, a copy goes to Sent (set `[mail] saveSentCopy = false` for servers that file sent mail themselves, such as Gmail).
- **No sending without you:** the model cannot send. Its `mail_send_draft` calls are refused in code and logged, and while email text is in its context it is not even offered write-tier tools. A draft whose recipient came from neither your message nor the email being answered is flagged on its card. If the app stops mid-send, the draft is marked "check your Sent folder" and is never resent on its own.
- **Chat context:** new-mail summaries are not added to the model's chat context. They come from email, and would put untrusted text in front of every turn. The model looks mail up with the tools instead.

## Desktop (kiosk)

Needs Omarchy 4 (Hyprland 0.55+, configured in Lua). `pnpm run setup` (or `pnpm run setup --kiosk` to skip the other questions) offers to:

- install `aios-core` as a `systemd --user` service that starts with the graphical session and restarts if it crashes (`~/.config/systemd/user/aios-core.service`);
- install `~/.local/bin/aios-kiosk`, which opens the chat as a Chromium app window with its own profile (`~/.local/share/aios/chromium`), or focuses it if it is already open;
- write `~/.config/hypr/aios.lua` (window rule: fullscreen on workspace 1, open at login, keys) and add one line to the end of `~/.config/hypr/hyprland.lua` to load it. The previous file is kept as `hyprland.lua.aios-backup`, and nothing is edited without a yes.

| Keys | What it does |
|---|---|
| `SUPER + SHIFT + ESCAPE` | Close the chat and show the desktop. If the chat doesn't close within half a second (hung), it is killed. |
| `SUPER + SHIFT + H` | Open the chat again, or focus it. |

Both are compositor key bindings, so they work even when the chat page is frozen. Omarchy's own `SUPER + Q` also closes the window.

**If the keys stop working:** press `Ctrl+Alt+F3`, log in, run `systemctl --user stop aios-core` and `~/.local/bin/aios-kiosk exit`, then `Ctrl+Alt+F1` (or F2) to go back. To turn the kiosk off for good, `pnpm --filter @aios/scripts uninstall` removes the service, the launcher, `aios.lua` and the line in `hyprland.lua`. If you only delete `aios.lua`, Hyprland keeps working: the line skips a missing file.

**Lock screen:** AI OS sets no idle inhibitor, so Omarchy's idle lock should still kick in over the chat window after the usual idle time. Check this once after installing.

**After `git pull`:** `pnpm kiosk:restart` rebuilds the UI and restarts the service. Don't run `pnpm start` at the same time; they share the port. After upgrading Node, run `pnpm run setup --kiosk` again: the service points at the Node binary that ran setup. `AIOS_KIOSK=0 aios-kiosk open` opens the chat in a normal browser window, and `[ui] kiosk = false` in the config keeps the service but doesn't open the chat at login.

## System controls

Needs Omarchy 4. Ask in your own words: "volume to 30", "mute", "brighter", "night light on", "do not disturb", "switch to my headphones", "mute the mic", "power saver", "lock the screen", "switch to the Gruvbox theme", "is Bluetooth on?", "how's the battery?". Changes go through Omarchy's own commands, so its on-screen display shows them just as the keyboard keys would.

| Request | What happens |
|---|---|
| Status: Wi-Fi, saved networks, Bluetooth devices, volume, outputs, brightness, battery, CPU and memory, themes | Answered straight away. Nothing changes. |
| Volume and mute, brightness, night light, do not disturb, audio output, microphone mute, power profile, screen lock, theme, Wi-Fi on, Bluetooth on or off, connect or disconnect a paired device | Done straight away (the `device` tier), then the chat says the new value. |
| Wi-Fi off, switch to another saved network, pair a new Bluetooth device, forget a device | A card asks first. Nothing changes until you click **Turn off**, **Connect**, **Pair** or **Forget**; **Cancel** changes nothing. |

- **Limits, enforced in code:** volume 0-100%, brightness 5-100% (never off), at most 10 changes a minute. Outputs, themes, networks and devices must be ones the computer itself lists.
- **Email can't change your computer:** the model sees an email's text only while it answers the request that read it. From your next message on, that whole exchange is replaced by a note saying an email was read (the model reads it again if you ask about it), so settings work normally and nothing is left over for an email to steer. A change asked for while an email is in view (for example "read Sara's email and dim the screen") shows a card with **Do it** instead of happening; Wi-Fi off, switching networks, pairing and forgetting aren't offered at all then. The chat on screen always keeps everything.
- **Wi-Fi passwords:** never read, shown or asked for. The chat only switches between networks this computer already saved. Join a new network in Omarchy's Network panel (`SUPER + CTRL + N`). Networks you never saved are counted, not named, because anyone nearby can name a network.
- **Pairing:** "pair my speaker" looks for devices for a few seconds and shows each one on its own card. The model never sees their names (anyone can name a Bluetooth device), so you pick the right card. Put the device in pairing mode first.
- **Pause:** `/pause` also stops every change, including clicks on these cards, until `/resume`.
- **Audit:** every change is logged with the setting's value before and after.
- **Not included:** keep-awake, sleep, restart and shut down, system updates, turning off the touchpad, touchscreen or keyboard.
- If a command is missing (not on Omarchy 4), the chat says which one. If the on-screen display doesn't appear when the service makes a change, the service may be missing the desktop session's environment: check that `systemctl --user show-environment` lists `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE`.

## Limits, failures and logs

- **Daily cost cap:** `[cost] dailyCapUsd` (default 2). Once today's spend (midnight to midnight in your timezone) reaches it, no model call is made by chat, mail triage or the nightly summary until tomorrow. The chat says so, `/cost` shows the numbers, and new mail is still listed by sender and subject without a summary. Spend is what the provider reports per call (OpenRouter does), so a provider that reports no cost is never capped.
- **Pause:** `/pause` stops every model call, from every part of the app, until `/resume`. It is checked in the model client itself, not only in the chat. Mail is still fetched and queued, and your own clicks on draft and memory cards still work. System changes stop too, including clicks on their cards.
- **When something fails, the chat says what and what to do:**
  - Model: wrong key, no credits, rate limit, timeout, provider down, no network, conversation too long.
  - API key missing or keyring locked: the chat still opens and says so. Before A7 the service crash-looped.
  - Mailbox: login rejected, server not found, connection refused, timeout, bad certificate, throttling, dropped connection, password missing from the keyring. aios-core keeps retrying and says when mail is back.
  - Sending: the draft card shows why it wasn't sent, with **Try again**.
  - Mail summaries and the nightly memory summary: one notice each, with the reason, then quiet retries.
  - The service itself: if the page loses aios-core for more than 5 seconds, a banner says how to see why. If the service never starts (for example an invalid config), `aios-kiosk` shows a desktop notification with the error instead of opening a full-screen error page.
- **Logs:** the audit log (`~/.local/share/aios/audit.jsonl`: every tool call, model call, command and memory decision, never message content) rotates at 10 MB and keeps 5 old files (`audit.jsonl.1` … `.5`). The service's own output goes to the systemd journal, which rotates it: `journalctl --user -u aios-core`.

## Testing

- `pnpm test` runs every unit test, and `pnpm test:injection` runs only the prompt-injection suite. That suite feeds each of the seven hostile test emails to a model that obeys them, through the real tools, approval brokers and memory. It checks that nothing is sent, no app opens, no memory or config file changes, no system command starts (one email asks to mute the computer and turn off Wi-Fi), and every write- and device-tier call is refused and logged. It also covers the system controls' limits, rate limit, pause and action cards.
- CI (`.github/workflows/ci.yml`) runs the typecheck, the injection suite and the unit tests on every PR and push to main. A second job starts GreenMail and runs the mail integration tests and the browser end-to-end check. CI never uses a real account or key.
- **Real test account:** for trying AI OS against a real mail server and model, use a dedicated throwaway mailbox, never your own.
  1. Create the mailbox (for example a new Gmail or Fastmail account), turn on two-step sign-in, and create an app password for it.
  2. Run `pnpm run setup`, answer no to the local test mailbox, and pick the provider. The app password goes straight into the keyring.
  3. Run `pnpm check:account`. It logs in over IMAP, finds Drafts and Sent, and checks the SMTP login, all without sending or changing anything.
  4. Optional: `pnpm check:account --seed-hostile` asks first, then adds the seven hostile test emails to that INBOX, so you can check that the real model ignores them too.
  5. Switch back to your own mailbox with `pnpm run setup` when you're done.

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
pnpm test:injection       # only the prompt-injection suite (seven hostile emails)
pnpm typecheck            # strict TypeScript
pnpm test:stack:up        # start GreenMail on 127.0.0.1 and seed 40 fixture emails
pnpm test:stack:check     # list the mailbox over IMAP
pnpm check:account        # read-only login check of the mailbox in your config (Drafts, Sent, SMTP)
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
packages/core     daemon: agent loop, Fastify/WebSocket server, SQLite store, memory, audit log, model adapter, keyring, tools, system controls
packages/ui       React chat UI (Vite + Tailwind): streaming chat, status strip
scripts           setup/uninstall CLI, mail seeder and checker, browser e2e check
fixtures/mail.ts  41 sample emails: threads, attachments, 7 hostile samples
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

## Dependencies added in A5

| Package | Why | License | Maintenance |
|---|---|---|---|
| nodemailer (in core; already used by scripts since A0, same version) | builds the outgoing message and sends it over SMTP | MIT-0 | very active (same author as imapflow) |

## Dependencies added in A7

No new packages. CI uses three GitHub Actions, pinned to their current major versions:

| Action | Why | License | Maintenance |
|---|---|---|---|
| actions/checkout@v7 | check out the repo | MIT | GitHub, very active |
| pnpm/action-setup@v6 | install pnpm at the version in `packageManager` | MIT | pnpm team, active |
| actions/setup-node@v7 | install Node 22 and cache the pnpm store | MIT | GitHub, very active |
