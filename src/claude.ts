/**
 * pi-multi-accounts, Claude part — keep several Anthropic (Claude Pro/Max) OAuth logins and
 * switch between them.
 *
 * Flow:
 *   1. /login                → built-in Pi login (Anthropic). Pi writes auth.json.
 *   2. /account save work    → snapshot the current login under the name "work".
 *   3. /logout, /login with the other Claude account, then /account save personal
 *   4. /account work | /account personal | /account (picker) to switch.
 *
 * How it works: Pi keeps exactly one `anthropic` credential in auth.json and
 * re-reads the file when its revision changes. This extension stores the other
 * logins in ~/.pi/agent/claude-accounts.json (mode 0600) and swaps the
 * `anthropic` entry in auth.json under the same `auth.json.lock` directory lock
 * that Pi's proper-lockfile uses. All store writes also happen under that lock.
 *
 * Refresh tokens rotate: Pi refreshes the active token and writes the new one
 * to auth.json. The extension syncs that rotated token back into the active
 * slot (on session start, after each agent run, and inside every switch), so a
 * stored slot never holds a dead refresh token.
 *
 * Note: auth.json is shared — switching affects every running Pi session.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeEntry, ClaudeStatus } from "./accounts.ts";

const PROVIDER = "anthropic";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const STORE_PATH = join(AGENT_DIR, "claude-accounts.json");
const LOCK_PATH = `${AUTH_PATH}.lock`;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000; // a Pi token refresh can hold the lock ~15 s
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const STATUS_KEY = "claude-account";
export const SUBCOMMANDS = ["save", "add", "list", "ls", "remove", "rm", "use", "switch", "help"];

interface OAuthCred {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

interface Identity {
	accountId?: string;
	email?: string;
}

interface Slot extends Identity {
	cred: OAuthCred;
	savedAt: number;
}

interface Store {
	active?: string;
	accounts: Record<string, Slot>;
}

// ---------- file helpers ----------

/** Missing file → undefined. Corrupt file → throw (never silently wipe data). */
function readJsonStrict<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${path} is not valid JSON; fix or remove it.`);
	}
}

function writeAtomic(path: string, data: unknown): void {
	mkdirSync(AGENT_DIR, { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
	renameSync(tmp, path);
}

function loadStore(): Store {
	const s = readJsonStrict<Store>(STORE_PATH) ?? { accounts: {} };
	if (!s.accounts || typeof s.accounts !== "object") s.accounts = {};
	return s;
}

function isOAuth(c: unknown): c is OAuthCred {
	const o = c as OAuthCred | undefined;
	return !!o && o.type === "oauth" && typeof o.refresh === "string" && typeof o.access === "string";
}

export function readAuth(): Record<string, unknown> {
	return readJsonStrict<Record<string, unknown>>(AUTH_PATH) ?? {};
}

function readCurrentCred(): OAuthCred | undefined {
	const c = readAuth()[PROVIDER];
	return isOAuth(c) ? c : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Same lock directory as proper-lockfile (`auth.json.lock`), so Pi and we
 * serialize. `fn` must be synchronous: nothing can interleave while we hold it.
 */
async function withAuthLock<T>(fn: () => T): Promise<T> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		if (Date.now() > deadline) throw new Error("auth.json is locked by another process; try again.");
		try {
			mkdirSync(LOCK_PATH);
			break;
		} catch (err) {
			if ((err as { code?: string }).code !== "EEXIST") throw err;
		}
		try {
			if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
				rmdirSync(LOCK_PATH);
				continue;
			}
		} catch (err) {
			if ((err as { code?: string }).code === "ENOENT") continue; // lock vanished — retry now
			throw err;
		}
		await sleep(50 + Math.random() * 100);
	}
	try {
		return fn();
	} finally {
		try {
			rmdirSync(LOCK_PATH);
		} catch {
			/* already gone */
		}
	}
}

/** Locked read-modify-write of the store. */
function mutateStore<T>(fn: (store: Store) => T): Promise<T> {
	return withAuthLock(() => {
		const store = loadStore();
		const result = fn(store);
		writeAtomic(STORE_PATH, store);
		return result;
	});
}

// ---------- identity ----------

/** Best effort: ask Anthropic who owns this token. Undefined on any failure. */
async function fetchProfile(cred: OAuthCred): Promise<Identity | undefined> {
	if (!cred.access || cred.expires <= Date.now() + 30_000) return undefined;
	try {
		const res = await fetch(PROFILE_URL, {
			headers: {
				Authorization: `Bearer ${cred.access}`,
				"anthropic-beta": "oauth-2025-04-20",
				"Content-Type": "application/json",
			},
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as { account?: { uuid?: string; email_address?: string; email?: string } };
		const accountId = body.account?.uuid;
		const email = body.account?.email_address ?? body.account?.email;
		return accountId || email ? { accountId, email } : undefined;
	} catch {
		return undefined;
	}
}

function findByToken(store: Store, cred: OAuthCred): string | undefined {
	return Object.keys(store.accounts).find((n) => store.accounts[n].cred.refresh === cred.refresh);
}

function findByIdentity(store: Store, id?: Identity): string | undefined {
	if (!id) return undefined;
	return Object.keys(store.accounts).find((n) => {
		const s = store.accounts[n];
		return id.accountId ? s.accountId === id.accountId : !!id.email && s.email === id.email;
	});
}

// ---------- sync ----------

type SyncResult =
	| { kind: "none" } // no anthropic OAuth login in auth.json
	| { kind: "matched"; name: string; cred: OAuthCred } // auth.json belongs to a stored slot
	| {
			kind: "unknown"; // no slot owns this login
			cred: OAuthCred;
			profile?: Identity; // undefined → identity could not be checked
			probable?: string; // profile unknown: likely the active slot after a token rotation
	  };

/**
 * Reconcile auth.json with the store. Copies a rotated token back into its
 * slot when ownership is certain (same refresh token, or same account id).
 */
async function sync(): Promise<SyncResult> {
	const cred = readCurrentCred();
	if (!cred) return { kind: "none" };
	const store = loadStore();

	let name = findByToken(store, cred);
	let profile: Identity | undefined;
	if (!name) {
		profile = await fetchProfile(cred);
		name = findByIdentity(store, profile);
	}
	if (!name) {
		const probable = !profile && store.active && store.accounts[store.active] ? store.active : undefined;
		return { kind: "unknown", cred, profile, probable };
	}

	const slot = store.accounts[name];
	if (slot.cred.refresh !== cred.refresh || slot.cred.access !== cred.access || store.active !== name) {
		const owner = name;
		await mutateStore((s) => {
			const now = readCurrentCred();
			if (!s.accounts[owner] || now?.refresh !== cred.refresh) return; // changed meanwhile; next sync handles it
			s.accounts[owner].cred = cred;
			if (profile?.accountId) s.accounts[owner].accountId = profile.accountId;
			if (profile?.email) s.accounts[owner].email = profile.email;
			s.active = owner;
		});
	}
	return { kind: "matched", name, cred };
}

function label(name: string, slot: Slot): string {
	return slot.email ? `${name} <${slot.email}>` : name;
}

function updateStatus(ctx: ExtensionContext, result: SyncResult): void {
	if (!ctx.hasUI) return;
	const text =
		result.kind === "matched" ? `claude: ${result.name}` : result.kind === "unknown" ? "claude: unsaved login" : undefined;
	ctx.ui.setStatus(STATUS_KEY, text);
}

// ---------- Claude adapter ----------

export const ClaudeProvider = {
	getStatus: overview,
	getSavedNames: () => Object.keys(loadStore().accounts),
	useAccount: cmdUse,
	saveAccount: cmdSave,
	removeAccount: cmdRemove,
};

async function cmdSave(name: string, ctx: ExtensionContext): Promise<void> {
	if (!/^[\w.-]+$/.test(name) || SUBCOMMANDS.includes(name)) {
		ctx.ui.notify(`Usage: /account save <name>  (letters, digits, . _ -; not ${SUBCOMMANDS.join("/")})`, "warning");
		return;
	}
	const cred = readCurrentCred();
	if (!cred) {
		ctx.ui.notify("No Anthropic OAuth login in auth.json. Run /login first.", "warning");
		return;
	}
	const store = loadStore();
	const owner = findByToken(store, cred);
	if (owner && owner !== name) {
		ctx.ui.notify(`This login is already saved as "${owner}".`, "warning");
		return;
	}
	const profile = await fetchProfile(cred);
	const dup = findByIdentity(store, profile);
	if (dup && dup !== name) {
		ctx.ui.notify(`This Claude account is already saved as "${dup}" — updated that slot instead.`, "info");
		name = dup;
	} else if (store.accounts[name] && owner !== name) {
		const ok = await ctx.ui.confirm("Overwrite account?", `"${name}" already exists. Replace it with the current login?`);
		if (!ok) return;
	}
	const target = name;
	const slot = await mutateStore((s) => {
		const now = readCurrentCred();
		if (now?.refresh !== cred.refresh) throw new Error("auth.json changed while saving; run the command again.");
		s.accounts[target] = { cred: now, accountId: profile?.accountId, email: profile?.email, savedAt: Date.now() };
		s.active = target;
		return s.accounts[target];
	});
	ctx.ui.notify(`Saved current Anthropic login as "${label(target, slot)}".`, "info");
	updateStatus(ctx, { kind: "matched", name: target, cred });
}

async function cmdUse(name: string, ctx: ExtensionContext): Promise<void> {
	const known = loadStore().accounts[name];
	if (!known) {
		ctx.ui.notify(`Unknown account "${name}". Saved: ${Object.keys(loadStore().accounts).join(", ") || "(none)"}`, "error");
		return;
	}

	const before = await sync();
	if (before.kind === "matched" && before.name === name) {
		ctx.ui.notify(`Already using "${label(name, known)}".`, "info");
		updateStatus(ctx, before);
		return;
	}

	// Who owns the token now in auth.json? It must be saved before we overwrite it.
	let owner: string | undefined = before.kind === "matched" ? before.name : undefined;
	if (before.kind === "unknown") {
		const who = before.profile?.email ? ` (${before.profile.email})` : "";
		if (before.probable) {
			const keep = `Keep it as "${before.probable}" (a refreshed token)`;
			const drop = "Discard it (it is a different, unsaved login)";
			const choice = await ctx.ui.select(`The current login${who} could not be identified`, [keep, drop]);
			if (!choice) return;
			owner = choice === keep ? before.probable : undefined;
		} else {
			const ok = await ctx.ui.confirm(
				"Unsaved login",
				`The current Anthropic login${who} is not saved. Switching removes it from auth.json. ` +
					"Continue? (Cancel, then /account save <name> to keep it.)",
			);
			if (!ok) return;
		}
	}

	const seen = before.kind === "none" ? undefined : before.cred.refresh;
	const slot = await mutateStore((s) => {
		const target = s.accounts[name];
		if (!target) throw new Error(`Account "${name}" was removed meanwhile.`);
		const auth = readAuth();
		const now = isOAuth(auth[PROVIDER]) ? auth[PROVIDER] : undefined;
		if (now?.refresh !== seen && !owner) {
			throw new Error("auth.json changed during the switch; run the command again.");
		}
		// Save the outgoing token (it may have rotated since sync) into its slot.
		if (now && owner && s.accounts[owner]) s.accounts[owner].cred = now;
		auth[PROVIDER] = target.cred;
		writeAtomic(AUTH_PATH, auth);
		s.active = name;
		return target;
	});
	ctx.ui.notify(`Switched Anthropic account to "${label(name, slot)}".`, "info");
	updateStatus(ctx, { kind: "matched", name, cred: slot.cred });
}

async function cmdRemove(name: string, ctx: ExtensionContext): Promise<void> {
	if (!loadStore().accounts[name]) {
		ctx.ui.notify(`Unknown account "${name}".`, "error");
		return;
	}
	const ok = await ctx.ui.confirm("Remove account?", `Forget saved login "${name}"? (auth.json is not changed.)`);
	if (!ok) return;
	await mutateStore((s) => {
		delete s.accounts[name];
		if (s.active === name) s.active = undefined;
	});
	ctx.ui.notify(`Removed "${name}".`, "info");
	updateStatus(ctx, await sync());
}

async function overview(ctx: ExtensionContext): Promise<ClaudeStatus> {
	const result = await sync();
	updateStatus(ctx, result);
	const store = loadStore();
	const active = result.kind === "matched" ? result.name : undefined;
	const entries: ClaudeEntry[] = Object.keys(store.accounts).map((name) => ({
		provider: "claude",
		id: name,
		name,
		email: store.accounts[name].email,
		isActive: name === active,
	}));
	const unsavedLogin = result.kind === "unknown" ? { email: result.profile?.email } : undefined;
	return { entries, unsavedLogin };
}

export function registerClaude(pi: ExtensionAPI): void {
	const quietSync = async (ctx: ExtensionContext, announce: boolean) => {
		try {
			const result = await sync();
			updateStatus(ctx, result);
			if (announce && result.kind === "unknown" && !result.probable && ctx.hasUI) {
				const who = result.profile?.email ? ` (${result.profile.email})` : "";
				ctx.ui.notify(`Unsaved Anthropic login${who}. Run /account save <name> to keep it.`, "info");
			}
		} catch {
			/* never break the session over account bookkeeping */
		}
	};

	pi.on("session_start", (_e, ctx) => quietSync(ctx, true));
	pi.on("agent_end", (_e, ctx) => quietSync(ctx, false));
}
