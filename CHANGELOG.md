# Changelog

Releases are git tags (`v0.1.0`). `./install.sh` installs the newest one; `./install.sh --ref <tag>` a given one.

## v0.2.0 (unreleased): Astra

AI OS becomes **Astra**, an app others can install (R1). Your AI OS keeps working as it is: an
install with only `~/.config/aios` keeps its folders, service, keyring and port 7777.

- **Arch package** (`packaging/arch`): installs the program in `/usr/lib/astra` with an `astra` command and a launcher entry; nothing in your home folder changes until `astra setup`.
- **`astra` command:** `astra` opens the chat; `setup`, `doctor`, `backup`, `restore FILE`, `calendar-login`, `uninstall [--purge]`, `version`.
- **Own names:** `~/.config/astra`, `~/.local/share/astra`, `astra.service`, keyring service `astra`, and port 7780, so Astra and AI OS can live on one computer (on different accounts).
- `install.sh` installs from source into `~/.local/share/astra/app`; restores put a backup back under the names it was made with.

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
