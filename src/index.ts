/** pi-multi-accounts — several Claude logins (/account) + extra Codex logins as parallel providers. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerClaude } from "./claude.ts";
import { registerCodex } from "./codex.ts";

export default function (pi: ExtensionAPI) {
	const codexHomes = registerCodex(pi);
	registerClaude(pi, codexHomes);
}
