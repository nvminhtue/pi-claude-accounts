import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

// The extension reads PI_CODING_AGENT_DIR at module load: set it before importing.
const dir = mkdtempSync(join(tmpdir(), "pi-multi-accounts-"));
process.env.PI_CODING_AGENT_DIR = dir;
// Codex homes are discovered under $HOME: point it at a temp dir with one fake ~/.codex-team.
const home = mkdtempSync(join(tmpdir(), "pi-multi-accounts-home-"));
process.env.HOME = home;
const jwt = (c) => ["e30", Buffer.from(JSON.stringify(c)).toString("base64url"), "sig"].join(".");
mkdirSync(join(home, ".codex-team"));
writeFileSync(
	join(home, ".codex-team", "auth.json"),
	JSON.stringify({
		tokens: {
			access_token: jwt({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-team" } }),
			refresh_token: "codex-refresh",
		},
	}),
);
// Never hit the network: profile lookup must fail and return undefined.
let networkCalls = 0;
globalThis.fetch = () => {
	networkCalls++;
	return Promise.reject(new Error("network disabled in tests"));
};

const AUTH = join(dir, "auth.json");
const STORE = join(dir, "claude-accounts.json");

const cred = (n) => ({ type: "oauth", refresh: `refresh-${n}`, access: `access-${n}`, expires: Date.now() + 3_600_000 });
const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const writeAuth = (anthropic) =>
	writeFileSync(AUTH, JSON.stringify({ anthropic, openai: { type: "api_key", key: "openai-key" } }, null, 2));

const commands = new Map();
const events = new Map();
const providers = new Map();
let commandRegistrations = 0;
let setModelCalls = [];
let setModelImpl = async (model) => { ctx.model = model; return true; };
const pi = {
	setModel: async (model) => { setModelCalls.push(model); return setModelImpl(model); },
	registerCommand: (name, def) => { commandRegistrations++; commands.set(name, def); },
	registerProvider: (name, def) => providers.set(name, def),
	on: (event, handler) => events.set(event, handler),
};

let models = [{ provider: "openai-codex-team", id: "shared", name: "Shared" }];
let notices = [];
let statuses = [];
let selectImpl = async () => undefined;
let confirmImpl = async () => true;
const ctx = {
	hasUI: true,
	model: { provider: "anthropic", id: "shared", name: "Shared" },
	modelRegistry: {
		find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		getAll: () => models,
		hasConfiguredAuth: () => true,
	},
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
	assert.equal(commandRegistrations, 1);
	assert.ok(events.has("session_start"));
	assert.ok(events.has("agent_end"));
});

test("registers the Codex home as a parallel provider", () => {
	assert.deepEqual([...providers.keys()], ["openai-codex-team"]);
	assert.equal(providers.get("openai-codex-team").api, "openai-codex-responses");
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
	assert.equal(rows.length, 3);
	assert.ok(rows.some((r) => r.startsWith("[Claude] ●") && r.includes("work")));
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
	assert.deepEqual(values, ["use claude:personal", "use claude:work", "use codex:openai-codex-team", "use openai-codex-team", "use personal", "use work"]);
});

test("store file is private and no lock or temp files are left behind", () => {
	assert.equal(statSync(STORE).mode & 0o777, 0o600);
	assert.equal(existsSync(`${AUTH}.lock`), false);
	const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
	assert.deepEqual(leftovers, []);
});

test("list shows Codex providers: not logged in, then logged in", async () => {
	resetUi();
	await account("list");
	const before = lastNotice().message;
	assert.match(before, /^Claude accounts \(credentials shared across Pi sessions\):/);
	assert.match(before, /Codex providers \(model selection for this session only\):/);
	assert.match(before, /openai-codex-team .*auth\.json {2}not logged in \(\/login → "OpenAI Codex \(team\)"\)/);

	resetUi();
	const auth = readJson(AUTH);
	auth["openai-codex-team"] = { type: "oauth", refresh: "r", access: "a", expires: Date.now() + 3_600_000 };
	writeFileSync(AUTH, JSON.stringify(auth));
	await account("list");
	assert.match(lastNotice().message, /openai-codex-team .*auth\.json {2}logged in$/);
});

test("the picker offers typed Claude and Codex targets", async () => {
	resetUi();
	let rows = [];
	selectImpl = async (_title, options) => {
		rows = options;
		return undefined;
	};
	await account("");
	assert.ok(rows.length > 0);
	assert.ok(rows.some((r) => r.startsWith("[Claude]")));
	assert.ok(rows.some((r) => r.startsWith("[Codex]") && r.includes("codex:openai-codex-team")));
	assert.equal(new Set(rows).size, rows.length);
});

test("help explains provider qualifiers and session effects", async () => {
	resetUi();
	await account("help");
	assert.match(lastNotice().message, /Save and remove are Claude-only\./);
	assert.match(lastNotice().message, /openai-codex-<name>/);
	assert.match(lastNotice().message, /claude:<name>/);
	assert.match(lastNotice().message, /codex:<id>/);
	assert.match(lastNotice().message, /only this session/);
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

const resetFixture = () => {
	resetUi();
	ctx.hasUI = true;
	ctx.model = { provider: "anthropic", id: "shared", name: "Shared" };
	ctx.modelRegistry.hasConfiguredAuth = () => true;
	models = [{ provider: "openai-codex-team", id: "shared", name: "Shared" }];
	setModelCalls = [];
	setModelImpl = async (model) => { ctx.model = model; return true; };
	writeAuth(cred("work"));
	writeFileSync(STORE, JSON.stringify({ active: "work", accounts: {
		work: { cred: cred("work"), savedAt: 1, email: "work@example.com" },
		personal: { cred: cred("personal"), savedAt: 1 },
	} }));
};
const snapshotCredentials = () => [readFileSync(AUTH, "utf8"), readFileSync(STORE, "utf8")];
const completions = (prefix) => commands.get("account").getArgumentCompletions(prefix);
const values = (prefix) => completions(prefix)?.map((entry) => entry.value) ?? [];
const addSlot = (name) => {
	const store = readJson(STORE);
	store.accounts[name] = { cred: cred(name), savedAt: 1 };
	writeFileSync(STORE, JSON.stringify(store));
};

for (const args of ["", "use", "switch"]) {
	test(`empty ${args || "input"} uses the unified picker`, async () => {
		resetFixture();
		let offered;
		selectImpl = async (_title, rows) => { offered = rows; return undefined; };
		const before = snapshotCredentials();
		await account(args);
		assert.equal(offered.length, 3);
		assert.ok(offered.some((row) => row.startsWith("[Codex]")));
		assert.deepEqual(snapshotCredentials(), before);
		assert.equal(setModelCalls.length, 0);
	});
}

test("non-UI empty input lists complete status without a dialog", async () => {
	resetFixture();
	ctx.hasUI = false;
	selectImpl = () => { throw new Error("no dialog expected"); };
	await account("");
	assert.match(lastNotice().message, /work@example.com/);
	assert.match(lastNotice().message, /not logged in.*\/login/);
});

test("aliases preserve save, list, switch and remove operations without capability warnings", async () => {
	resetFixture();
	writeAuth(cred("alias"));
	await account("add alias");
	assert.equal(notices.length, 1);
	assert.match(lastNotice().message, /Saved current/);
	await account("ls");
	assert.match(lastNotice().message, /Claude accounts/);
	await account("switch work");
	assert.equal(readJson(AUTH).anthropic.refresh, "refresh-work");
	await account("use alias");
	assert.equal(readJson(AUTH).anthropic.refresh, "refresh-alias");
	resetUi();
	await account("rm alias");
	assert.equal(notices.length, 1);
	assert.match(lastNotice().message, /Removed/);
	assert.ok(!readJson(STORE).accounts.alias);
});

test("invalid save, reserved aliases, unknown remove and cancellations have no false capability warnings", async () => {
	resetFixture();
	const before = snapshotCredentials();
	for (const name of ["", "bad name", "claude:work", "save", "add", "list", "ls", "remove", "rm", "use", "switch", "help"]) {
		resetUi();
		await account(`save ${name}`);
		assert.equal(notices.length, 1);
		assert.match(lastNotice().message, /Usage/);
		assert.equal(lastNotice().level, "warning");
	}
	assert.deepEqual(snapshotCredentials(), before);
	resetUi();
	await account("remove nobody");
	assert.equal(notices.length, 1);
	assert.equal(lastNotice().level, "error");
	resetUi();
	confirmImpl = async () => false;
	await account("remove personal");
	assert.equal(notices.length, 0);
	writeAuth(cred("unsaved"));
	await account("save personal");
	assert.equal(notices.length, 0);
	assert.equal(readJson(STORE).accounts.personal.cred.refresh, "refresh-personal");
});

test("save and remove treat Codex-looking arguments as literal Claude names", async () => {
	resetFixture();
	writeAuth(cred("collision"));
	await account("save openai-codex-team");
	assert.ok(readJson(STORE).accounts["openai-codex-team"]);
	assert.equal(notices.length, 1);
	resetUi();
	await account("remove codex:openai-codex-team");
	assert.equal(lastNotice().level, "error");
	assert.ok(readJson(STORE).accounts["openai-codex-team"]);
	resetUi();
	await account("remove openai-codex-team");
	assert.equal(notices.length, 1);
	assert.match(lastNotice().message, /Removed/);
	assert.equal(setModelCalls.length, 0);
});

test("a valid Codex-prefix Claude name uses Claude through direct and picker paths", async () => {
	resetFixture();
	writeAuth(cred("prefixed"));
	await account("save openai-codex-project");
	assert.ok(readJson(STORE).accounts["openai-codex-project"]);
	await account("work");
	await account("openai-codex-project");
	assert.equal(readJson(AUTH).anthropic.refresh, "refresh-prefixed");
	await account("work");
	selectImpl = async (_title, rows) => rows.find((row) => row.startsWith("[Claude]") && row.includes("openai-codex-project"));
	await account("");
	assert.equal(readJson(AUTH).anthropic.refresh, "refresh-prefixed");
	assert.equal(setModelCalls.length, 0);
	assert.equal(ctx.model.provider, "anthropic");
});

test("exact collisions require a qualifier; both qualified paths keep their owner", async () => {
	resetFixture();
	addSlot("openai-codex-team");
	const before = snapshotCredentials();
	await account("openai-codex-team");
	assert.equal(lastNotice().level, "error");
	assert.match(lastNotice().message, /Ambiguous.*claude:openai-codex-team.*codex:openai-codex-team/);
	assert.deepEqual(snapshotCredentials(), before);
	assert.equal(setModelCalls.length, 0);
	await account("claude:openai-codex-team");
	assert.equal(readJson(AUTH).anthropic.refresh, "refresh-openai-codex-team");
	const claudeBefore = snapshotCredentials();
	await account("codex:openai-codex-team");
	assert.equal(ctx.model.provider, "openai-codex-team");
	assert.deepEqual(snapshotCredentials(), claudeBefore);
});

test("collision picker labels are unique and dispatch the retained provider", async () => {
	resetFixture();
	addSlot("openai-codex-team");
	let offered;
	selectImpl = async (_title, rows) => {
		offered = rows;
		return rows.find((row) => row.startsWith("[Claude]") && row.includes("claude:openai-codex-team"));
	};
	await account("");
	assert.equal(new Set(offered).size, offered.length);
	assert.equal(readJson(AUTH).anthropic.refresh, "refresh-openai-codex-team");
	assert.equal(setModelCalls.length, 0);
	const before = snapshotCredentials();
	selectImpl = async (_title, rows) => rows.find((row) => row.startsWith("[Codex]"));
	await account("");
	assert.equal(setModelCalls.length, 1);
	assert.deepEqual(snapshotCredentials(), before);
});

test("unknown targets and qualifiers never report success or mutate state", async () => {
	resetFixture();
	const before = snapshotCredentials();
	for (const target of ["openai-codex-missing", "claude:missing", "codex:missing", "other:work", ":work", "codex:work"]) {
		resetUi();
		await account(target);
		assert.equal(notices.length, 1);
		assert.equal(lastNotice().level, "error");
		assert.doesNotMatch(lastNotice().message, /Switched|now active/);
	}
	assert.deepEqual(snapshotCredentials(), before);
	assert.equal(setModelCalls.length, 0);
});

test("direct Codex use changes the session model without Claude sync or credential writes", async () => {
	resetFixture();
	writeAuth(cred("unsaved"));
	const before = snapshotCredentials();
	const callsBefore = networkCalls;
	selectImpl = () => { throw new Error("same-ID switch needs no picker"); };
	await account("openai-codex-team");
	assert.deepEqual(setModelCalls, [models[0]]);
	assert.equal(ctx.model, models[0]);
	assert.match(lastNotice().message, /Switched this session/);
	assert.equal(lastNotice().level, "info");
	assert.equal(networkCalls, callsBefore);
	assert.deepEqual(snapshotCredentials(), before);
});

test("Codex falls back to a chosen target model when the same ID is absent", async () => {
	resetFixture();
	models = [
		{ provider: "openai-codex-team", id: "first", name: "First" },
		{ provider: "anthropic", id: "other", name: "Other" },
		{ provider: "openai-codex-team", id: "second", name: "Second" },
	];
	selectImpl = async (title, rows) => {
		assert.match(title, /Choose a model/);
		assert.deepEqual(rows, ["First (first)", "Second (second)"]);
		return rows[1];
	};
	const before = snapshotCredentials();
	await account("use openai-codex-team");
	assert.equal(ctx.model.id, "second");
	assert.deepEqual(setModelCalls, [models[2]]);
	assert.deepEqual(snapshotCredentials(), before);
});

test("Codex accepts an undefined current model and prompts for a target model", async () => {
	resetFixture();
	ctx.model = undefined;
	selectImpl = async (_title, rows) => rows[0];
	await account("codex:openai-codex-team");
	assert.deepEqual(setModelCalls, [models[0]]);
	assert.equal(ctx.model.id, "shared");
});

test("Codex fallback cancellation leaves the model and credentials unchanged", async () => {
	resetFixture();
	ctx.model.id = "missing";
	const originalModel = ctx.model;
	const before = snapshotCredentials();
	await account("openai-codex-team");
	assert.equal(notices.length, 0);
	assert.equal(setModelCalls.length, 0);
	assert.equal(ctx.model, originalModel);
	assert.deepEqual(snapshotCredentials(), before);
});

for (const hasSameId of [true, false]) {
	test(`Codex missing auth reports login guidance before any dialog (same ID: ${hasSameId})`, async () => {
		resetFixture();
		if (!hasSameId) ctx.model.id = "missing";
		ctx.modelRegistry.hasConfiguredAuth = () => false;
		selectImpl = () => { throw new Error("auth check must precede dialog"); };
		await account("openai-codex-team");
		assert.equal(lastNotice().level, "error");
		assert.match(lastNotice().message, /\/login → "OpenAI Codex \(team\)"/);
		assert.equal(setModelCalls.length, 0);
		assert.equal(ctx.model.provider, "anthropic");
	});
}

test("Codex requires explicit /model selection without UI when a fallback is needed", async () => {
	resetFixture();
	ctx.hasUI = false;
	ctx.model.id = "missing";
	selectImpl = () => { throw new Error("no dialog expected"); };
	await account("openai-codex-team");
	assert.match(lastNotice().message, /explicitly with \/model/);
	assert.equal(setModelCalls.length, 0);
});

test("Codex reports no registered models without claiming a switch", async () => {
	resetFixture();
	models = [];
	await account("openai-codex-team");
	assert.equal(lastNotice().level, "error");
	assert.match(lastNotice().message, /No registered models/);
	assert.equal(setModelCalls.length, 0);
});

for (const result of ["false", "throw"]) {
	test(`Codex setModel ${result} reports a failure, not success`, async () => {
		resetFixture();
		const originalModel = ctx.model;
		const before = snapshotCredentials();
		setModelImpl = async () => {
			if (result === "throw") throw new Error("model change failed");
			return false;
		};
		await account("openai-codex-team");
		assert.equal(notices.length, 1);
		assert.equal(lastNotice().level, "error");
		assert.match(lastNotice().message, result === "false" ? /\/login/ : /account: model change failed/);
		assert.equal(setModelCalls.length, 1);
		assert.equal(ctx.model, originalModel);
		assert.deepEqual(snapshotCredentials(), before);
	});
}

test("Codex success waits for the awaited setModel result", async () => {
	resetFixture();
	let resolveModel;
	setModelImpl = (model) => new Promise((resolve) => { resolveModel = () => { ctx.model = model; resolve(true); }; });
	const pending = account("openai-codex-team");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(notices.length, 0);
	resolveModel();
	await pending;
	assert.match(lastNotice().message, /Switched this session/);
});

test("list preserves unsaved Claude email, saved email, active marks and non-selectable notices", async () => {
	resetFixture();
	writeAuth(cred("unsaved"));
	const blockedFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ account: { uuid: "new-account", email_address: "unsaved@example.com" } });
	try {
		await account("list");
		assert.match(lastNotice().message, /unsaved login in auth.json \(unsaved@example.com\).*\/account save/);
		assert.match(lastNotice().message, /work <work@example.com>/);
		selectImpl = async (_title, rows) => {
			assert.ok(rows.every((row) => !row.includes("unsaved login")));
			assert.equal(rows.length, 3);
			return undefined;
		};
		await account("");
	} finally {
		globalThis.fetch = blockedFetch;
	}
	resetFixture();
	ctx.model = models[0];
	await account("list");
	assert.match(lastNotice().message, /\[Claude\] ● work/);
	assert.match(lastNotice().message, /● team  openai-codex-team/);
});

test("empty Claude status keeps login and save guidance", async () => {
	resetFixture();
	writeFileSync(STORE, JSON.stringify({ accounts: {} }));
	writeAuth(undefined);
	await account("list");
	assert.match(lastNotice().message, /No saved accounts\. Run \/login, then \/account save <name>/);
});

test("corrupt auth is reported and remains unchanged", async () => {
	resetFixture();
	writeFileSync(AUTH, "{ corrupt auth SECRET");
	const before = snapshotCredentials();
	await account("list");
	assert.equal(lastNotice().level, "error");
	assert.match(lastNotice().message, /not valid JSON/);
	assert.doesNotMatch(lastNotice().message, /SECRET/);
	assert.deepEqual(snapshotCredentials(), before);
});

test("late Codex homes remain unavailable until a fresh registration snapshot", async () => {
	resetFixture();
	mkdirSync(join(home, ".codex-late"));
	writeFileSync(join(home, ".codex-late", "auth.json"), "{}");
	await account("list");
	assert.doesNotMatch(lastNotice().message, /openai-codex-late/);
	let offered;
	selectImpl = async (_title, rows) => { offered = rows; return undefined; };
	await account("");
	assert.ok(offered.every((row) => !row.includes("openai-codex-late")));
	assert.deepEqual(values("openai-codex-late"), []);
	await account("codex:openai-codex-late");
	assert.equal(lastNotice().level, "error");
	assert.equal(setModelCalls.length, 0);
	const freshCommands = new Map();
	const freshProviders = new Map();
	const { default: register } = await import("../src/index.ts");
	register({ ...pi, registerCommand: (name, def) => freshCommands.set(name, def), registerProvider: (name, def) => freshProviders.set(name, def) });
	assert.ok(freshProviders.has("openai-codex-late"));
	assert.ok(freshCommands.get("account").getArgumentCompletions("openai-codex-late"));
	models.push({ provider: "openai-codex-late", id: "shared", name: "Shared" });
	await freshCommands.get("account").handler("openai-codex-late", ctx);
	assert.equal(ctx.model.provider, "openai-codex-late");
});

test("completions are synchronous and preserve static prefixes, aliases and literal remove names", () => {
	resetFixture();
	const before = snapshotCredentials();
	const callsBefore = networkCalls;
	assert.deepEqual(values("sa"), ["save"]);
	assert.deepEqual(values("ad"), ["add"]);
	assert.ok(values("l").includes("ls"));
	assert.deepEqual(values("remove ").sort(), ["remove personal", "remove work"]);
	assert.deepEqual(values("rm ").sort(), ["rm personal", "rm work"]);
	assert.ok(values("switch ").includes("switch openai-codex-team"));
	assert.deepEqual(values("claude:w"), ["claude:work"]);
	assert.deepEqual(values("codex:o"), ["codex:openai-codex-team"]);
	assert.deepEqual(values("wor"), ["work"]);
	assert.equal(completions("no-match"), null);
	assert.equal(completions("save "), null);
	assert.ok(Array.isArray(completions("use ")));
	assert.equal(networkCalls, callsBefore);
	assert.deepEqual(snapshotCredentials(), before);
});

test("collision completions exclude ambiguous targets and offer both qualifiers", () => {
	resetFixture();
	addSlot("openai-codex-team");
	for (const prefix of ["", "use ", "switch "]) {
		const entries = values(prefix);
		assert.ok(!entries.includes(`${prefix}openai-codex-team`));
		assert.ok(entries.includes(`${prefix}claude:openai-codex-team`));
		assert.ok(entries.includes(`${prefix}codex:openai-codex-team`));
	}
	assert.ok(values("remove ").includes("remove openai-codex-team"));
	assert.ok(!values("remove ").some((value) => value.includes(":")));
});

test("corrupt-store completions keep static and snapshot Codex candidates without writes or network", () => {
	resetFixture();
	writeFileSync(STORE, "{ corrupt store");
	const before = snapshotCredentials();
	const callsBefore = networkCalls;
	assert.deepEqual(values("sa"), ["save"]);
	assert.ok(values("use ").includes("use openai-codex-team"));
	assert.deepEqual(values("codex:"), ["codex:openai-codex-team"]);
	assert.equal(completions("remove "), null);
	assert.equal(networkCalls, callsBefore);
	assert.deepEqual(snapshotCredentials(), before);
});

test("list renders full Codex paths with spaces instead of parsing display strings", async () => {
	resetFixture();
	const { registerAccounts } = await import("../src/accounts.ts");
	let command;
	const path = join(home, "folder with spaces", ".codex-space", "auth.json");
	registerAccounts({ ...pi, registerCommand: (_name, def) => { command = def; } }, [
		{ name: "space", dir: join(home, "folder with spaces", ".codex-space"), authPath: path },
	]);
	await command.handler("list", ctx);
	assert.ok(lastNotice().message.includes(`openai-codex-space  ${path}  not logged in`));
	assert.match(lastNotice().message, /\/login → "OpenAI Codex \(space\)"/);
});

test("Claude adapter returns typed status entries without credentials or command labels", async () => {
	resetFixture();
	const { ClaudeProvider } = await import("../src/claude.ts");
	assert.deepEqual(await ClaudeProvider.getStatus(ctx), {
		entries: [
			{ provider: "claude", id: "work", name: "work", email: "work@example.com", isActive: true },
			{ provider: "claude", id: "personal", name: "personal", email: undefined, isActive: false },
		],
		unsavedLogin: undefined,
	});
});
