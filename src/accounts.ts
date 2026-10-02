import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ClaudeProvider, SUBCOMMANDS } from "./claude.ts";
import { createCodexProvider } from "./codex.ts";
import type { CodexHome } from "./codex.ts";

export interface ClaudeEntry {
	provider: "claude";
	id: string;
	name: string;
	email?: string;
	isActive: boolean;
}

export interface CodexEntry {
	provider: "codex";
	id: string;
	name: string;
	authPath: string;
	isLoggedIn: boolean;
	isActive: boolean;
}

export interface ClaudeStatus {
	entries: ClaudeEntry[];
	unsavedLogin?: { email?: string };
}

type AccountEntry = ClaudeEntry | CodexEntry;

function formatClaudeName(entry: ClaudeEntry): string {
	return entry.email ? `${entry.name} <${entry.email}>` : entry.name;
}

function formatPickerLabel(entry: AccountEntry): string {
	const marker = entry.isActive ? "●" : "○";
	if (entry.provider === "claude") {
		return `[Claude] ${marker} ${formatClaudeName(entry)} (claude:${entry.id})`;
	}
	return `[Codex] ${marker} ${entry.name} (codex:${entry.id})`;
}

function formatList(claude: ClaudeStatus, codex: CodexEntry[]): string {
	const lines = ["Claude accounts (credentials shared across Pi sessions):"];
	for (const entry of claude.entries) {
		const marker = entry.isActive ? "●" : "○";
		lines.push(`[Claude] ${marker} ${formatClaudeName(entry)}`);
	}
	if (!claude.entries.length) lines.push("No saved accounts. Run /login, then /account save <name>.");
	if (claude.unsavedLogin) {
		const email = claude.unsavedLogin.email ? ` (${claude.unsavedLogin.email})` : "";
		lines.push(`! unsaved login in auth.json${email} — /account save <name>`);
	}
	lines.push("", "Codex providers (model selection for this session only):");
	for (const entry of codex) {
		const state = entry.isLoggedIn ? "logged in" : `not logged in (/login → "OpenAI Codex (${entry.name})")`;
		const marker = entry.isActive ? "●" : "○";
		lines.push(`  ${marker} ${entry.name}  ${entry.id}  ${entry.authPath}  ${state}`);
	}
	if (!codex.length) lines.push("No registered Codex homes. Run /reload after adding a home.");
	return lines.join("\n");
}

function getTargetSuggestions(names: string[], ids: string[]): string[] {
	const collisions = names.filter((name) => ids.includes(name));
	return [
		...names.filter((name) => !collisions.includes(name)),
		...ids.filter((id) => !collisions.includes(id)),
		...names.map((name) => `claude:${name}`),
		...ids.map((id) => `codex:${id}`),
	];
}

function getCompletions(prefix: string, ids: string[]) {
	let names: string[] = [];
	try {
		names = ClaudeProvider.getSavedNames();
	} catch {
		/* Keep static and registered Codex completions available for a corrupt store. */
	}
	const targets = getTargetSuggestions(names, ids);
	const candidates = [
		...SUBCOMMANDS,
		...targets,
		...targets.flatMap((target) => [`use ${target}`, `switch ${target}`]),
		...names.flatMap((name) => [`remove ${name}`, `rm ${name}`]),
	];
	const matches = candidates.filter((candidate) => candidate.startsWith(prefix));
	return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

export function registerAccounts(pi: ExtensionAPI, homes: readonly CodexHome[]): void {
	const codex = createCodexProvider(pi, homes);

	async function cmdList(ctx: ExtensionContext): Promise<void> {
		const claude = await ClaudeProvider.getStatus(ctx);
		ctx.ui.notify(formatList(claude, codex.getEntries(ctx)), "info");
	}

	async function useEntry(entry: AccountEntry, ctx: ExtensionContext): Promise<void> {
		if (entry.provider === "claude") await ClaudeProvider.useAccount(entry.id, ctx);
		else await codex.useAccount(entry.id, ctx);
	}

	async function cmdPick(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return cmdList(ctx);
		const claude = await ClaudeProvider.getStatus(ctx);
		const entries: AccountEntry[] = [...claude.entries, ...codex.getEntries(ctx)];
		if (!entries.length) return cmdList(ctx);
		const labels = entries.map(formatPickerLabel);
		const choice = await ctx.ui.select("Switch account or provider", labels);
		const entry = entries.find((_entry, index) => labels[index] === choice);
		if (entry) await useEntry(entry, ctx);
	}

	async function cmdUse(target: string, ctx: ExtensionContext): Promise<void> {
		if (!target) return cmdPick(ctx);
		const separator = target.indexOf(":");
		const qualifier = separator < 0 ? undefined : target.slice(0, separator);
		const id = separator < 0 ? target : target.slice(separator + 1);
		if (qualifier !== undefined && qualifier !== "claude" && qualifier !== "codex") {
			throw new Error(`Unknown account qualifier "${qualifier}". Use claude: or codex:.`);
		}
		const isCodex = qualifier !== "claude" && codex.getIds().includes(id);
		const isClaude = qualifier !== "codex" && ClaudeProvider.getSavedNames().includes(id);
		if (isClaude && isCodex) {
			throw new Error(`Ambiguous account "${id}". Use claude:${id} or codex:${id}.`);
		}
		if (isClaude) await ClaudeProvider.useAccount(id, ctx);
		else if (isCodex) await codex.useAccount(id, ctx);
		else throw new Error(`Unknown account "${target}". Run /account list; new Codex homes require /reload.`);
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
		const arg = rest.join(" ");
		switch (sub) {
			case undefined: return cmdPick(ctx);
			case "save":
			case "add": return ClaudeProvider.saveAccount(arg, ctx);
			case "remove":
			case "rm": return ClaudeProvider.removeAccount(arg, ctx);
			case "use":
			case "switch": return cmdUse(arg, ctx);
			case "list":
			case "ls": return cmdList(ctx);
			case "help": return ctx.ui.notify(HELP, "info");
			default: return cmdUse(args.trim(), ctx);
		}
	}

	pi.registerCommand("account", {
		description: "Unified account and provider management — /account help",
		getArgumentCompletions: (prefix) => getCompletions(prefix, codex.getIds()),
		handler: async (args, ctx) => {
			try {
				await handleCommand(args, ctx);
			} catch (err) {
				ctx.ui.notify(`account: ${(err as Error).message}`, "error");
			}
		},
	});
}

const HELP = [
	"/account                 pick a Claude account or Codex provider",
	"/account <name/id>       use an exact saved Claude name or registered Codex ID",
	"/account use|switch      pick or use a target",
	"/account claude:<name>   choose Claude when a name collides with a Codex ID",
	"/account codex:<id>      choose Codex when an ID collides with a Claude name",
	"/account save|add <name> save current Claude login (literal Claude name)",
	"/account remove|rm <name> forget saved Claude login (literal Claude name)",
	"/account list|ls         list accounts, login states and auth paths",
	"Claude changes shared credentials, not the session model. Save and remove are Claude-only.",
	"Codex changes only this session's model, not Claude credentials or the default model.",
	"Codex IDs: openai-codex-<name>. Run /login first; /reload after adding a home.",
	"Codex keeps the current model ID when supported; otherwise choose a model (or use /model without UI).",
].join("\n");
