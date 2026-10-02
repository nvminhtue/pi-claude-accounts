# pi-multi-accounts

A [Pi](https://github.com/earendil-works/pi) extension for people with more than one subscription:

- **Claude**: keep **multiple Claude Pro/Max OAuth accounts** for Pi's built-in `/login` and switch between them with a single `/account` command. Pi stores exactly one `anthropic` credential; this extension saves additional logins next to it and swaps the active one on demand.
- **Codex**: use extra **ChatGPT (Codex) logins as parallel providers** (`openai-codex-<name>`) next to Pi's built-in `openai-codex`. Use `/account` to select a provider for this session, or pick its model with `/model`.

## Install

```bash
# local checkout
pi install /absolute/path/to/pi-multi-accounts

# or from git
pi install git:github.com/<user>/pi-multi-accounts
```

Then run `/reload` (or restart Pi).

### Migrating from the standalone extensions / the old package

- Remove `~/.pi/agent/extensions/codex-accounts.ts` and `~/.pi/agent/extensions/claude-accounts.ts` if present. Otherwise the commands and providers are registered twice.
- Remove old `pi-claude-accounts` package entries from your Pi settings.
- `~/.pi/agent/claude-accounts.json` is kept: your saved Claude accounts continue to work.

## Usage

| Command                 | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `/account`              | Pick a Claude account or a registered Codex provider |
| `/account <name/id>`    | Use an exact saved Claude name or registered Codex provider ID |
| `/account save <name>`  | Save the current Anthropic `/login` under `<name>`  |
| `/account list`         | List Claude accounts (● active, ○ inactive) and Codex providers (login state) |
| `/account remove <name>`| Forget a saved Claude account (`auth.json` is not changed) |
| `/account help`         | Show command help                                   |

Save and remove work on **Claude accounts only**. Their arguments are literal Claude names, not provider qualifiers.

Claude selection changes shared credentials. It does not change the session model. Codex selection changes only this session's model. It does not change Claude credentials or the default model for new sessions.

Use an unqualified name or ID when it matches exactly one provider. If a saved Claude name equals a registered Codex ID, use `/account claude:<name>` or `/account codex:<provider-id>`. Existing Claude names such as `openai-codex-team` remain valid. The picker identifies each provider and does not need qualifiers.

`/account use` and `/account switch` without a target open the same picker. Prefix completions include the aliases, saved names, registered Codex IDs, and qualified targets. Completions for `remove` and `rm` include only literal Claude names.

Aliases: `add` = `save`, `ls` = `list`, `rm` = `remove`, `use`/`switch` = switch.

The footer shows `claude: <name>` for the active saved account, or `claude: unsaved login` when the login in `auth.json` is not saved yet.

## Logging in to a second account

1. `/login` with your first Claude account, then `/account save work`.
2. Run `/login` again. Pi reuses the browser's existing claude.ai session, so you would simply get the same account back. To avoid that, do one of:
   - open the login URL Pi prints in a **private/incognito window**, or
   - use a **different browser profile**, or
   - **sign out of claude.ai** first.

   Copy the login URL Pi prints into the private window and sign in with the second account.
3. `/account save personal`.
4. Run `/account list` and check that the emails differ.

## Codex accounts

1. For each extra ChatGPT account, log in with the Codex CLI into its own folder: `CODEX_HOME=~/.codex-<name> codex login`.
2. In Pi, run `/login` and choose **"OpenAI Codex (<name>)"**. This imports the tokens from `~/.codex-<name>/auth.json`; no browser is involved.
3. Select the provider with `/account openai-codex-<name>`, or use the unified `/account` picker. The command keeps the current model ID if the target provider supports it. Otherwise, it asks you to choose a target model. Cancel leaves the session unchanged. Without dialog support, choose explicitly with `/model`, e.g. `openai-codex-<name>/<model>`.

The provider has the same models as the built-in `openai-codex`. Run `/login` first to configure its auth in Pi. The command reports success only after Pi accepts the model change. `/account list` shows each provider's auth path, login state, and current-session active marker.

The Codex auth file stays the source of truth: on refresh the extension first adopts newer tokens found in the file (e.g. refreshed by the Codex CLI); otherwise it refreshes with the file's refresh token and writes the rotated tokens back. New `~/.codex-*` folders are discovered at load time, so run `/reload` after creating one.

## How it works (Claude)

- Pi keeps a single `anthropic` entry in `~/.pi/agent/auth.json`. Switching replaces that entry and leaves other providers untouched.
- Saved logins live in `~/.pi/agent/claude-accounts.json` (mode `0600`).
- Writes happen under the same `auth.json.lock` directory lock that Pi's `proper-lockfile` uses, so Pi and the extension never write at the same time.
- Refresh tokens rotate. When Pi refreshes the active token, the extension copies the new one back into the right slot on `session_start`, after each `agent_end`, and during every switch.
- To tell whose token is whose, it asks `https://api.anthropic.com/api/oauth/profile` for the account id/email. If that lookup fails, it falls back gracefully (matching on the refresh token, or asking you when ownership is unclear).

## Caveats

- `auth.json` is shared: a Claude switch affects **every running Pi session**. A Codex switch changes only the current session model.
- It relies on Pi internals (the `auth.json` format and its lock directory). Tested with Pi 0.99.2.
- The Anthropic profile endpoint is unofficial and may change.
- The OpenAI token endpoint and client id used for Codex refresh are unofficial and may change.
- The Codex CLI and Pi share each Codex refresh token (single use); if both refresh at once, one of them may need `codex login` and `/login` again.
- `claude-accounts.json` contains refresh tokens. Keep it private and never commit it.

## Development

```bash
npm install
npm run check   # typecheck + tests
```

Layout:

```text
src/index.ts                  entry point: shares one registered Codex-home snapshot
src/accounts.ts               /account command, typed entries, exact resolution and completions
src/claude.ts                 Claude credentials, status, validation and lifecycle sync
src/codex.ts                  Codex parallel providers and session-model selection
test/account.test.mjs         node:test suite for /account (temp PI_CODING_AGENT_DIR and HOME, no network)
test/codex.test.mjs           node:test suite for the Codex providers (stubbed fetch, no network)
```

## License

MIT
