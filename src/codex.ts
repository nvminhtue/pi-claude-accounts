/**
 * pi-multi-accounts, Codex part — use extra ChatGPT (Codex) logins in parallel
 * with the built-in `openai-codex` provider.
 *
 * Every ~/.codex-<name>/auth.json (Codex CLI format) becomes a separate Pi
 * provider `openai-codex-<name>` with the same models as `openai-codex`, e.g.
 * ~/.codex-huy → `openai-codex-huy/gpt-5.5`. Streaming reuses Pi's built-in
 * `openai-codex-responses` implementation; the chatgpt-account-id header is
 * derived from the access token, so each provider talks as its own account.
 *
 * Setup: /login → "OpenAI Codex (<name>)" imports the tokens from the file
 * (no browser). Then pick the model with /model.
 *
 * The Codex auth file stays the source of truth: on refresh the extension
 * first adopts newer tokens from the file (e.g. refreshed by
 * `CODEX_HOME=~/.codex-<name> codex`), otherwise it refreshes with the file's
 * refresh token and writes the rotated tokens back, so Pi and the Codex CLI
 * keep sharing one valid login.
 */
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const BASE_URL = "https://chatgpt.com/backend-api";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const EXPIRY_SKEW_MS = 5 * 60_000;
const HOME_DIR_PATTERN = /^\.codex-([a-z0-9][a-z0-9_-]*)$/i;

interface CodexAuthFile {
	auth_mode?: string;
	tokens?: {
		id_token?: string;
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	};
	last_refresh?: string;
	[key: string]: unknown;
}

export interface CodexCred {
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
	[key: string]: unknown;
}

export interface CodexHome {
	name: string;
	dir: string;
	authPath: string;
}

function jwtClaims(token: string): Record<string, any> {
	const payload = token.split(".")[1];
	if (!payload) throw new Error("access token is not a JWT");
	return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function readAuthFile(path: string): CodexAuthFile {
	// Tolerate non-breaking-space indentation left by copy/paste.
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/\u00a0/g, " "));
	} catch {
		// Never surface the parser message: it can quote token characters.
		throw new Error(`${path} is missing or not valid JSON`);
	}
}

export function credFromTokens(access: string, refresh: string): CodexCred {
	const claims = jwtClaims(access);
	const accountId = claims[JWT_AUTH_CLAIM]?.chatgpt_account_id;
	if (typeof accountId !== "string" || !accountId) throw new Error("access token has no chatgpt_account_id");
	if (typeof claims.exp !== "number") throw new Error("access token has no exp claim");
	return { access, refresh, expires: claims.exp * 1000, accountId };
}

export function credFromFile(path: string): CodexCred {
	const tokens = readAuthFile(path).tokens;
	if (!tokens?.access_token || !tokens.refresh_token) {
		throw new Error(`${path} has no ChatGPT tokens; run \`CODEX_HOME=${join(path, "..")} codex login\` first`);
	}
	return credFromTokens(tokens.access_token, tokens.refresh_token);
}

export function writeBack(path: string, fresh: { access: string; refresh: string; idToken?: string; accountId: string }): void {
	const file = readAuthFile(path);
	file.tokens = {
		...file.tokens,
		access_token: fresh.access,
		refresh_token: fresh.refresh,
		...(fresh.idToken ? { id_token: fresh.idToken } : {}),
		account_id: fresh.accountId,
	};
	file.last_refresh = new Date().toISOString();
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

export function isFresh(cred: CodexCred, now = Date.now()): boolean {
	return cred.expires - now > EXPIRY_SKEW_MS;
}

/** True when the auth file holds newer, still-valid tokens than `currentAccess`. */
export function shouldAdopt(fromFile: CodexCred, currentAccess: string, now = Date.now()): boolean {
	return fromFile.access !== currentAccess && isFresh(fromFile, now);
}

export async function refreshCred(home: CodexHome, refreshToken: string, signal: AbortSignal): Promise<CodexCred> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }),
		signal,
	});
	if (!response.ok) {
		// The Codex CLI may have rotated the single-use refresh token meanwhile.
		const latest = credFromFile(home.authPath);
		if (latest.refresh !== refreshToken && isFresh(latest)) return latest;
		const body = (await response.json().catch(() => ({}))) as { error?: unknown };
		const code = typeof body.error === "string" ? ` (${body.error})` : "";
		throw new Error(
			`OpenAI Codex (${home.name}) token refresh failed: HTTP ${response.status}${code}. ` +
				`Run \`CODEX_HOME=${home.dir} codex login\`, then /login again.`,
		);
	}
	const json = (await response.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
	if (!json.access_token) throw new Error(`OpenAI Codex (${home.name}) token refresh returned no access token`);
	const cred = credFromTokens(json.access_token, json.refresh_token ?? refreshToken);
	try {
		writeBack(home.authPath, { ...cred, idToken: json.id_token });
	} catch (error) {
		// Pi still persists the rotated token; only the Codex CLI copy is stale.
		console.warn(`pi-multi-accounts: could not update ${home.authPath}: ${(error as Error).message}`);
	}
	return cred;
}

export function discoverHomes(root = homedir()): CodexHome[] {
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && HOME_DIR_PATTERN.test(entry.name))
		.map((entry) => ({
			name: (HOME_DIR_PATTERN.exec(entry.name)?.[1] ?? entry.name).toLowerCase(),
			dir: join(root, entry.name),
			authPath: join(root, entry.name, "auth.json"),
		}))
		.filter((home) => existsSync(home.authPath));
}

function codexModels(): ProviderModelConfig[] {
	return getBuiltinModels("openai-codex").map(({ provider: _provider, ...model }) => ({ ...model }) as ProviderModelConfig);
}

export function registerCodex(pi: ExtensionAPI, homes = discoverHomes()): CodexHome[] {
	const models = codexModels();
	for (const home of homes) {
		pi.registerProvider(`openai-codex-${home.name}`, {
			name: `OpenAI Codex (${home.name})`,
			baseUrl: BASE_URL,
			api: "openai-codex-responses",
			models,
			oauth: {
				name: `OpenAI Codex (${home.name})`,
				isSubscription: true,
				async login(callbacks) {
					const cred = credFromFile(home.authPath);
					callbacks.onProgress?.(`Imported ChatGPT login from ${home.authPath}`);
					return cred;
				},
				async refreshToken(credentials, signal) {
					// Adopt tokens the Codex CLI refreshed meanwhile; otherwise refresh ourselves.
					const fromFile = credFromFile(home.authPath);
					if (shouldAdopt(fromFile, credentials.access)) return fromFile;
					return refreshCred(home, fromFile.refresh, signal);
				},
				getApiKey: (credentials) => credentials.access,
			},
		});
	}
	return homes;
}

/** Status lines for `/account list`: one per Codex home, by login state in Pi's auth.json. */
export function codexRows(homes: CodexHome[], auth: Record<string, unknown>): string[] {
	return homes.map((home) => {
		const id = `openai-codex-${home.name}`;
		const entry = auth[id] as { type?: unknown } | undefined;
		const state = entry?.type === "oauth" ? "logged in" : `not logged in (/login → "OpenAI Codex (${home.name})")`;
		return `  ${home.name}  ${id}  ${home.authPath}  ${state}`;
	});
}
