import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

// The extension reads PI_CODING_AGENT_DIR at module load: set it before importing.
const dir = mkdtempSync(join(tmpdir(), "pi-claude-accounts-"));
process.env.PI_CODING_AGENT_DIR = dir;
// Never hit the network: profile lookup must fail and return undefined.
globalThis.fetch = () => Promise.reject(new Error("network disabled in tests"));

const AUTH = join(dir, "auth.json");
const STORE = join(dir, "claude-accounts.json");

const cred = (n) => ({ type: "oauth", refresh: `refresh-${n}`, access: `access-${n}`, expires: Date.now() + 3_600_000 });
const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const writeAuth = (anthropic) =>
	writeFileSync(AUTH, JSON.stringify({ anthropic, openai: { type: "api_key", key: "openai-key" } }, null, 2));

const commands = new Map();
const events = new Map();
const pi = {
	registerCommand: (name, def) => commands.set(name, def),
	on: (event, handler) => events.set(event, handler),
};

let notices = [];
let statuses = [];
let selectImpl = async () => undefined;
let confirmImpl = async () => true;
const ctx = {
	hasUI: true,
	ui: {
		notify: (message, level) => notices.push({ message, level }),
		setStatus: (key, text) => statuses.push({ key, text }),
		confirm: (title, message) => confirmImpl(title, message),
		select: (title, options) => selectImpl(title, options),
	},
};

const account = (args) => commands.get("account").handler(args, ctx);
const lastNotice = () => notices[notices.length - 1];
const resetUi = () => {
	notices = [];
	statuses = [];
	selectImpl = async () => undefined;
	confirmImpl = async () => true;
};

before(async () => {
	const mod = await import("../src/index.ts");
	mod.default(pi);
});

test("registers the account command and lifecycle hooks", () => {
	assert.ok(commands.has("account"));
	assert.ok(events.has("session_start"));
	assert.ok(events.has("agent_end"));
});

test("save stores the current login and marks it active", async () => {
	resetUi();
	writeAuth(cred("work"));
	await account("save work");
	const store = readJson(STORE);
	assert.equal(store.active, "work");
	assert.equal(store.accounts.work.cred.refresh, "refresh-work");
	assert.equal(lastNotice().level, "info");
	assert.match(lastNotice().message, /Saved current Anthropic login as "work"/);
	assert.deepEqual(statuses.at(-1), { key: "claude-account", text: "claude: work" });
});

test("reserved names are rejected", async () => {
	resetUi();
	const before = readFileSync(STORE, "utf-8");
	await account("save list");
	assert.equal(lastNotice().level, "warning");
	assert.match(lastNotice().message, /Usage: \/account save <name>/);
	assert.equal(readFileSync(STORE, "utf-8"), before);
});

test("a second login can be saved under another name", async () => {
	resetUi();
	writeAuth(cred("personal"));
	await account("save personal");
	const store = readJson(STORE);
	assert.equal(store.active, "personal");
	assert.deepEqual(Object.keys(store.accounts).sort(), ["personal", "work"]);
	assert.equal(store.accounts.work.cred.refresh, "refresh-work");
	assert.equal(store.accounts.personal.cred.refresh, "refresh-personal");
});

test("rotated token is kept in the right slot when switching", async () => {
	resetUi();
	// Pi refreshed the active (personal) token: auth.json now has a new refresh token.
	const rotated = cred("personal-rotated");
	writeAuth(rotated);
	await events.get("agent_end")({}, ctx);
	assert.deepEqual(statuses.at(-1), { key: "claude-account", text: "claude: unsaved login" });

	let offered = [];
	selectImpl = async (_title, options) => {
		offered = options;
		return options.find((o) => o.startsWith("Keep it as"));
	};
	await account("work");

	assert.ok(offered.some((o) => o.startsWith('Keep it as "personal"')));
	const store = readJson(STORE);
	assert.equal(store.accounts.personal.cred.refresh, "refresh-personal-rotated");
	assert.equal(store.accounts.work.cred.refresh, "refresh-work");
	assert.equal(store.active, "work");
	assert.match(lastNotice().message, /Switched Anthropic account to "work"/);
});

test("switch writes the target credential into auth.json and keeps other providers", async () => {
	const auth = readJson(AUTH);
	assert.equal(auth.anthropic.refresh, "refresh-work");
	assert.deepEqual(auth.openai, { type: "api_key", key: "openai-key" });
	assert.deepEqual(statuses.at(-1), { key: "claude-account", text: "claude: work" });
});

test("the picker (/account with no args) switches accounts", async () => {
	resetUi();
	let rows = [];
	selectImpl = async (_title, options) => {
		rows = options;
		return options.find((r) => r.includes("personal"));
	};
	await account("");
	assert.equal(rows.length, 2);
	assert.ok(rows.some((r) => r.startsWith("●") && r.includes("work")));
	assert.equal(readJson(AUTH).anthropic.refresh, "refresh-personal-rotated");
	assert.equal(readJson(STORE).active, "personal");
	assert.match(lastNotice().message, /Switched Anthropic account to "personal"/);
});

test("unknown account name reports an error", async () => {
	resetUi();
	await account("nobody");
	assert.equal(lastNotice().level, "error");
	assert.match(lastNotice().message, /Unknown account "nobody"/);
});

test("argument completions list `use <name>` entries", () => {
	const { getArgumentCompletions } = commands.get("account");
	const values = getArgumentCompletions("use ").map((i) => i.value).sort();
	assert.deepEqual(values, ["use personal", "use work"]);
});

test("store file is private and no lock or temp files are left behind", () => {
	assert.equal(statSync(STORE).mode & 0o777, 0o600);
	assert.equal(existsSync(`${AUTH}.lock`), false);
	const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
	assert.deepEqual(leftovers, []);
});

test("a corrupt store is reported and left unchanged", async () => {
	resetUi();
	const garbage = "{ not json";
	writeFileSync(STORE, garbage);
	await account("list");
	assert.equal(lastNotice().level, "error");
	assert.match(lastNotice().message, /not valid JSON/);
	assert.equal(readFileSync(STORE, "utf-8"), garbage);
	assert.equal(existsSync(`${AUTH}.lock`), false);
});
