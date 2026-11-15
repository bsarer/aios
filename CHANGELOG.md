# Changelog

Releases are git tags (`v0.1.0`). `./install.sh` installs the newest one; `./install.sh --ref <tag>` a given one.

## v0.2.0 (unreleased): Astra

AI OS becomes **Astra**, an app others can install (R1). Your AI OS keeps working as it is: an
install with only `~/.config/aios` keeps its folders, service, keyring and port 7777.

- **Arch package** (`packaging/arch`): installs the program in `/usr/lib/astra` with an `astra` command and a launcher entry; nothing in your home folder changes until `astra setup`.
- **`astra` command:** `astra` opens the chat; `setup`, `doctor`, `backup`, `restore FILE`, `calendar-login`, `uninstall [--purge]`, `version`.
- **Own names:** `~/.config/astra`, `~/.local/share/astra`, `astra.service`, keyring service `astra`, and port 7780, so Astra and AI OS can live on one computer (on different accounts).
- `install.sh` installs from source into `~/.local/share/astra/app`; restores put a backup back under the names it was made with.
- **Voice and tone:** `[personality]` (the assistant's name and tone) and `/tone` to change it from the chat; the knowledge base reads a large Gmail inbox (K3).
- **Setup in a window** (R2): `astra` the first time, `astra setup` and `astra settings` open setup in a window. It asks only what it can't find out, tests the AI key and the mail sign-in before you go on (with what to do when they fail), and fills in Gmail's and Google Workspace's servers. `astra setup --terminal` keeps the terminal questions.
- **Updates** (U1): `astra update` pulls the checkout the package was built from, builds, installs (asks for your password) and restarts Astra; settings stay. In the chat, `/update` shows what's new with an Update button that opens a terminal for it. `astra update --check` only looks.
- **Music** (MU1): "pause the music", "skip this song" and "what's playing?" control Spotify (or any player playerctl knows); `/music`, `/music pause`, `/music next` do it without the model. Song names count as outside text.
- **Links and web searches** (T8): "open bbc.com" or "search the web for …" opens a new Chromium window away from the chat, and the screen follows it; `/web` does it without the model. Links from an email or document wait for a click on a card.
- **Google Contacts** (C3): with the calendar signed in, "email Sam" finds Sam's address and "what's Sara's number?" answers, read only, through the same Google sign-in. Enable the People API in your Google Cloud project and run `astra calendar-login` once.
- **`astra stop`** closes the chat and stops Astra; opening it from the app menu starts it again.
- **Voice in setup:** setup finds whisper.cpp where the README builds it (`~/.local/src/whisper.cpp`) and turns the microphone on when its server answers on 127.0.0.1:8178.
- **Setup keeps your settings:** running `astra setup` again keeps the sections it doesn't ask about (`[files]` folders, `[screen]`, `[personality]`, `[knowledge]`, speech and embeddings models). Before, a re-run dropped them.

## v0.1.0 (alpha, 2026-11)

The first release that can be installed with `install.sh`. AI OS is a chat that runs as a full
screen kiosk on Omarchy 4 (Hyprland 0.55+) and works with your mail, calendar, files and apps.
Anything that sends, changes or deletes waits for your click on a card; every tool call is in the
audit log; text from mail, invites and documents is treated as untrusted.

- **Chat and memory** (A2, A3): streaming chat, slash commands, Markdown memory with suggested facts you approve.
- **Mail** (A4, A5, S2, M1): IMAP read tools, a watcher and a triage worker with no tools, reply drafts sent only from a hash-checked Send card, attachments read as untrusted text, and files from your folders attached to drafts.
- **Desktop** (A6, S1, S7): systemd service and Hyprland kiosk; system controls through Omarchy's commands; the chat keeps one full screen on its own workspace, apps open on another screen or the next workspace, and an AI button on Omarchy's top bar (or Super+Shift+H) brings it back.
- **Apps** (S3, S4, S5): start installed apps, build small web apps with Claude Code, and ask for changes from inside them.
- **Calendar** (C1): Google Calendar read and change cards.
- **Word and Excel** (D1, D2): read documents and sheets; edits write a new file unless you ask to overwrite.
- **Files** (F1, F2): browse, search, copy, move and rename inside the folders you choose; never replace or delete.
- **System assistant** (L1): an optional local model (Ollama) that suggests tidy-ups you confirm.
- **Hardening** (A7): spend cap, pause, quiet hours, rate limits and redacted logs.
- **Packaging** (P1): `install.sh` (install, upgrade, `--check`, `--restore`), `pnpm doctor` and `/doctor`, `pnpm backup`.

Known limits: alpha quality, one user per computer, English only, Omarchy 4 only. Keyring secrets
are never in a backup; after a restore on a new computer, `pnpm run setup` asks for them again.
