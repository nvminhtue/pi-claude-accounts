import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	codexRows,
	credFromFile,
	credFromTokens,
	discoverHomes,
	isFresh,
	refreshCred,
	registerCodex,
	shouldAdopt,
	writeBack,
} from "../src/codex.ts";

const jwt = (c) => ["e30", Buffer.from(JSON.stringify(c)).toString("base64url"), "sig"].join(".");
const AUTH_CLAIM = "https://api.openai.com/auth";
const access = (accountId, expSeconds) => jwt({ exp: expSeconds, [AUTH_CLAIM]: { chatgpt_account_id: accountId } });
const inSeconds = (s) => Math.floor(Date.now() / 1000) + s;
const tmp = () => mkdtempSync(join(tmpdir(), "pi-multi-accounts-codex-"));

const stubFetch = (impl) => {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init });
		return impl(url, init);
	};
	return calls;
};
const noFetch = () => {
	globalThis.fetch = () => {
		throw new Error("network disabled in tests");
	};
};
noFetch();
// Never restore the real fetch: every test runs with the network blocked.
afterEach(noFetch);

const writeAuthFile = (dir, body) => {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "auth.json");
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	return path;
};
const fileWith = (accessToken, refresh, extra = {}) => ({
	auth_mode: "chatgpt",
	OPENAI_API_KEY: null,
	tokens: { id_token: "old-id", access_token: accessToken, refresh_token: refresh, account_id: "acct-1" },
	...extra,
});
const homeFor = (root, name = "huy") => ({
	name,
	dir: join(root, `.codex-${name}`),
	authPath: join(root, `.codex-${name}`, "auth.json"),
});
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

test("discoverHomes finds only .codex-<name> dirs that have auth.json", () => {
	const root = tmp();
	writeAuthFile(join(root, ".codex-Huy"), {});
	mkdirSync(join(root, ".codex-bob"));
	writeAuthFile(join(root, ".codex"), {});
	writeAuthFile(join(root, ".codexbar"), {});
	writeFileSync(join(root, ".codex-file"), "x");
	assert.deepEqual(discoverHomes(root), [
		{ name: "huy", dir: join(root, ".codex-Huy"), authPath: join(root, ".codex-Huy", "auth.json") },
	]);
});

test("credFromTokens extracts account id and expiry", () => {
	const token = access("acct-1", 2_000_000_000);
	assert.deepEqual(credFromTokens(token, "r"), {
		access: token,
		refresh: "r",
		expires: 2_000_000_000_000,
		accountId: "acct-1",
	});
});

test("credFromTokens rejects malformed tokens", () => {
	assert.throws(() => credFromTokens("not-a-jwt", "r"), /not a JWT/);
	assert.throws(() => credFromTokens(jwt({ exp: 1, [AUTH_CLAIM]: {} }), "r"), /no chatgpt_account_id/);
	assert.throws(() => credFromTokens(jwt({ [AUTH_CLAIM]: { chatgpt_account_id: "a" } }), "r"), /no exp claim/);
});

test("credFromFile tolerates NBSP indentation", () => {
	const root = tmp();
	const token = access("acct-1", inSeconds(3600));
	const json = JSON.stringify(fileWith(token, "r1"), null, 2).replace(/^ +/gm, (m) => "\u00a0".repeat(m.length));
	const path = writeAuthFile(root, json);
	assert.equal(credFromFile(path).refresh, "r1");
});

test("credFromFile explains missing tokens and hides invalid JSON content", () => {
	const root = tmp();
	const empty = writeAuthFile(join(root, "a"), { auth_mode: "apikey" });
	assert.throws(() => credFromFile(empty), /CODEX_HOME=/);

	const secret = "SECRET-TOKEN-TEXT";
	const bad = writeAuthFile(join(root, "b"), `{"tokens": "${secret}`);
	assert.throws(
		() => credFromFile(bad),
		(error) => /is missing or not valid JSON/.test(error.message) && !error.message.includes(secret),
	);
});

test("shouldAdopt only adopts different, fresh tokens", () => {
	const now = Date.now();
	const cred = (secondsAhead, token) => ({ access: token, refresh: "r", expires: now + secondsAhead * 1000, accountId: "a" });
	assert.equal(shouldAdopt(cred(3600, "same"), "same", now), false);
	assert.equal(shouldAdopt(cred(3600, "new"), "old", now), true);
	assert.equal(shouldAdopt(cred(120, "new"), "old", now), false);
	assert.equal(isFresh(cred(3600, "x"), now), true);
});

test("writeBack preserves unrelated fields and replaces tokens", () => {
	const root = tmp();
	const path = writeAuthFile(
		root,
		fileWith("old-access", "old-refresh", { unknown_key: { keep: true }, tokens: { ...fileWith("", "").tokens, extra: "keep-me" } }),
	);
	writeBack(path, { access: "new-access", refresh: "new-refresh", accountId: "acct-2" });
	const file = readJson(path);
	assert.equal(file.auth_mode, "chatgpt");
	assert.equal(file.OPENAI_API_KEY, null);
	assert.deepEqual(file.unknown_key, { keep: true });
	assert.equal(file.tokens.extra, "keep-me");
	assert.equal(file.tokens.access_token, "new-access");
	assert.equal(file.tokens.refresh_token, "new-refresh");
	assert.equal(file.tokens.account_id, "acct-2");
	assert.equal(file.tokens.id_token, "old-id");
	assert.ok(!Number.isNaN(Date.parse(file.last_refresh)));
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(root).filter((f) => f.endsWith(".tmp")), []);

	writeBack(path, { access: "a3", refresh: "r3", idToken: "new-id", accountId: "acct-2" });
	assert.equal(readJson(path).tokens.id_token, "new-id");
});

test("refreshCred posts a refresh_token grant, returns and writes back the new tokens", async () => {
	const root = tmp();
	const home = homeFor(root);
	writeAuthFile(home.dir, fileWith("old-access", "old-refresh"));
	const fresh = access("acct-1", inSeconds(3600));
	const calls = stubFetch(async () =>
		Response.json({ access_token: fresh, refresh_token: "rotated", id_token: "new-id" }),
	);
	const cred = await refreshCred(home, "old-refresh", new AbortController().signal);
	const body = String(calls[0].init.body);
	assert.match(body, /grant_type=refresh_token/);
	assert.match(body, /client_id=/);
	assert.match(body, /refresh_token=old-refresh/);
	assert.equal(cred.access, fresh);
	assert.equal(cred.refresh, "rotated");
	const file = readJson(home.authPath);
	assert.equal(file.tokens.access_token, fresh);
	assert.equal(file.tokens.refresh_token, "rotated");
	assert.equal(file.tokens.id_token, "new-id");
});

test("refreshCred race: adopts a newer refresh token from the file after HTTP 400", async () => {
	const root = tmp();
	const home = homeFor(root);
	const newer = access("acct-1", inSeconds(3600));
	writeAuthFile(home.dir, fileWith(newer, "file-refresh"));
	stubFetch(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
	const cred = await refreshCred(home, "stale-refresh", new AbortController().signal);
	assert.equal(cred.access, newer);
	assert.equal(cred.refresh, "file-refresh");
});

test("refreshCred fails when the file has the same refresh token", async () => {
	const root = tmp();
	const home = homeFor(root);
	writeAuthFile(home.dir, fileWith(access("acct-1", inSeconds(3600)), "same-refresh"));
	stubFetch(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
	await assert.rejects(
		() => refreshCred(home, "same-refresh", new AbortController().signal),
		/token refresh failed: HTTP 400 \(invalid_grant\)/,
	);
});

test("registerCodex wires login, refresh and getApiKey to the auth file", async () => {
	const root = tmp();
	const home = homeFor(root);
	const fileAccess = access("acct-1", inSeconds(3600));
	writeAuthFile(home.dir, fileWith(fileAccess, "file-refresh"));
	const providers = new Map();
	const returned = registerCodex({ registerProvider: (name, def) => providers.set(name, def) }, [home]);
	assert.deepEqual(returned, [home]);

	const { oauth, api, baseUrl } = providers.get("openai-codex-huy");
	assert.equal(api, "openai-codex-responses");
	assert.ok(baseUrl.startsWith("https://"));

	const progress = [];
	const loggedIn = await oauth.login({ onProgress: (m) => progress.push(m) });
	assert.equal(loggedIn.access, fileAccess);
	assert.equal(loggedIn.refresh, "file-refresh");
	assert.equal(progress.length, 1);
	assert.ok(progress[0].includes(home.authPath));

	// fetch is stubbed to throw: adopting the newer file tokens must not touch the network.
	const stale = { access: "stale", refresh: "stale-refresh", expires: Date.now() + 1000 };
	const refreshed = await oauth.refreshToken(stale, new AbortController().signal);
	assert.equal(refreshed.access, fileAccess);
	assert.equal(oauth.getApiKey(refreshed), fileAccess);
	assert.equal(existsSync(`${home.authPath}.${process.pid}.tmp`), false);
});

test("codexRows reports login state per home", () => {
	const root = tmp();
	const huy = homeFor(root, "huy");
	const bob = homeFor(root, "bob");
	const rows = codexRows([huy, bob], { "openai-codex-huy": { type: "oauth" }, "openai-codex-bob": { type: "api_key" } });
	assert.equal(rows[0], `  huy  openai-codex-huy  ${huy.authPath}  logged in`);
	assert.equal(rows[1], `  bob  openai-codex-bob  ${bob.authPath}  not logged in (/login → "OpenAI Codex (bob)")`);
	assert.deepEqual(codexRows([], {}), []);
});
