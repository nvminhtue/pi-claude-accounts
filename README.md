# pi-claude-accounts

A [Pi](https://github.com/earendil-works/pi) extension that lets you keep **multiple Claude Pro/Max OAuth accounts** for Pi's built-in `/login` and switch between them with a single `/account` command.

Pi stores exactly one `anthropic` credential. This extension saves additional logins next to it and swaps the active one on demand.

## Install

```bash
# local checkout
pi install /absolute/path/to/pi-claude-accounts

# or from git
pi install git:github.com/<user>/pi-claude-accounts
```

Then run `/reload` (or restart Pi).

> If you previously copied `claude-accounts.ts` into `~/.pi/agent/extensions/`, remove that copy. Otherwise the `/account` command is registered twice.

## Usage

| Command                 | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `/account`              | Pick an account from a list and switch to it        |
| `/account <name>`       | Switch to the saved account `<name>`                |
| `/account save <name>`  | Save the current `/login` under `<name>`            |
| `/account list`         | List saved accounts (● active, ○ inactive)          |
| `/account remove <name>`| Forget a saved account (`auth.json` is not changed) |
| `/account help`         | Show command help                                   |

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

## How it works

- Pi keeps a single `anthropic` entry in `~/.pi/agent/auth.json`. Switching replaces that entry and leaves other providers untouched.
- Saved logins live in `~/.pi/agent/claude-accounts.json` (mode `0600`).
- Writes happen under the same `auth.json.lock` directory lock that Pi's `proper-lockfile` uses, so Pi and the extension never write at the same time.
- Refresh tokens rotate. When Pi refreshes the active token, the extension copies the new one back into the right slot on `session_start`, after each `agent_end`, and during every switch.
- To tell whose token is whose, it asks `https://api.anthropic.com/api/oauth/profile` for the account id/email. If that lookup fails, it falls back gracefully (matching on the refresh token, or asking you when ownership is unclear).

## Caveats

- `auth.json` is shared: switching affects **every running Pi session**.
- It relies on Pi internals (the `auth.json` format and its lock directory). Tested with Pi 0.99.2.
- The Anthropic profile endpoint is unofficial and may change.
- `claude-accounts.json` contains refresh tokens. Keep it private and never commit it.

## Development

```bash
npm install
npm run check   # typecheck + tests
```

Layout:

```text
src/index.ts                  the extension (loaded directly by Pi, no build step)
test/claude-accounts.test.mjs node:test suite (uses a temp PI_CODING_AGENT_DIR, no network)
```

## License

MIT
