# Contributing to AI OS

Thanks for helping. AI OS reads people's mail and can act on their computer, so the rules below are
about safety first. Read [CLAUDE.md](CLAUDE.md) (the rules, for people and for Claude Code alike) and
the milestone you are working on in [AIOS_ALPHA_PLAN.md](AIOS_ALPHA_PLAN.md) before you start.

## Set up

On Omarchy 4 for the desktop parts; any Linux with Node 22.13+, pnpm 10 and Docker works for the rest.

```sh
git clone <your fork> && cd aios
pnpm install
pnpm typecheck && pnpm test     # must pass before every push
pnpm test:injection             # the hostile mail, invite and document suite
pnpm test:stack:up              # GreenMail on 127.0.0.1 with 40 fixture emails
pnpm test:e2e                   # the chat in Chromium against a mock model
pnpm test:stack:down
```

To run it for real on your own machine: `./install.sh` (or `pnpm run setup` in a clone), then `pnpm doctor`.

## Rules that reviews check

- **One milestone per pull request**, in the plan's order, with its plan entry agreed first. Small commits that each build and pass.
- **Never use real accounts or keys in tests.** Tests use the GreenMail stack, the pretend Google Calendar, Word, Excel and Hyprland in `fixtures/` and the tests, and temporary folders. Never commit a `.env`, a token or a config with secrets; secrets live only in the keyring.
- **Anything that sends, changes or deletes** goes through a hash-checked card the user clicks, enforced in code. A model's words alone never cause it.
- **Text from outside** (mail, invites, documents, file and window names) passes through `sanitize()` and `<untrusted>` tags, and can never write memory, call write-tier tools or change config. Every such change needs a test in the injection suite.
- **Workers with no tools stay that way** (triage, the file summarizer, the system assistant), each with a test that fails if a tool is added.
- **Every tool call is audited.** No vendor AI SDKs: models are reached only through `packages/core/src/model.ts`, and model names live in config.
- **New dependencies** are explained in the README (why, license, maintenance) and kept to a minimum.
- TypeScript strict, zod for all outside input, no `any` without a comment saying why.

Files that guard these rules are listed in [.github/CODEOWNERS](.github/CODEOWNERS); changes to them need the owner's review.

## Pull requests

Branch from `main`, keep the PR to one milestone or one fix, say what you tested (including on a
real Omarchy machine, if it touches the desktop), and wait for CI and a review. Releases are tagged
by the owner after merging and noted in [CHANGELOG.md](CHANGELOG.md).

## For the owner: GitHub settings before inviting developers

1. **Branch protection for `main`** (Settings → Branches, or Rules → Rulesets): require a pull request, 1 approving review, review from Code Owners, the CI checks "Typecheck, injection suite, unit tests" and "GreenMail integration and browser end-to-end" to pass, branches up to date, and conversation resolution; block force pushes and deletion; include administrators.
2. **Collaborators** (Settings → Collaborators): invite with the **Write** role, not Admin or Maintain.
3. **Actions** (Settings → Actions → General): "Require approval for all outside collaborators" for fork PRs, and workflow permissions "Read repository contents".
4. **Security** (Settings → Code security): turn on secret scanning, push protection, Dependabot alerts and security updates.
5. **Tags**: protect `v*` tags (Rules → Rulesets → Tag rules) so only you can create release tags.
6. **Private or public**: while the repo is private, only invited people see it. Before making it public, pick a license (none means nobody else may reuse the code) and check the history once more.
