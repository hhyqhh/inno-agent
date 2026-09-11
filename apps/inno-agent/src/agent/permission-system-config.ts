/**
 * Managed default for @gotgenes/pi-permission-system's config file.
 *
 * The plugin reads its global config from
 * `$PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json`, which
 * runtime.ts points at inno's configDir. Project-level overrides live at
 * `<workspace>/.pi/extensions/pi-permission-system/config.json` (the plugin
 * merges global → project, most-restrictive-wins).
 *
 * The integration policy encoded here:
 *
 * 1. `"*": "allow"` fallback. Inno is a learning agent whose own seven tool
 *    groups (learner/L2/L3/scheduler/practice/document/OCR) are the product,
 *    not a threat; the plugin's least-privilege default (`ask` on everything)
 *    would bury a learner under approval cards. Restrictions are carved out
 *    explicitly below.
 * 2. `bash` is the one surface that asks by default, with a read-only allow
 *    list (inspection commands) and a hard-deny list (destructive/privilege
 *    escalation). Web approvals are answered by the `inno-web` authorizer
 *    link (see permission-bridge.ts), which the chain only activates because
 *    it is named in `authorizerChain`.
 * 3. `path` is allow-with-sensitive-denies, and `external_directory` is fully
 *    allowed. Both surfaces are on the plugin's bounded-delegation exclusion
 *    list: a chain link's `allow` there is downgraded to `defer`, so in a
 *    headless server session an `ask` on them could never be approved from
 *    the web UI (it would fall through to the headless terminal deny). Asking
 *    would produce cards that cannot be meaningfully approved, so the managed
 *    default never generates asks on those surfaces. OS-level confinement
 *    remains pi-sandbox's job; inno's workspace-path-guard bounds the agent's
 *    own file tools.
 *
 * The file is only written when absent — user edits are never clobbered.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";

/**
 * Resolve a file inside an installed package to an absolute path, walking up
 * from the given module so it works from both `src/` (tsx) and compiled
 * `dist/`. Needed for packages whose exports map blocks the subpath we must
 * load through jiti (jiti enforces exports for package specifiers; absolute
 * file paths bypass that).
 */
export function resolvePluginFile(fromModuleUrl: string, packageName: string, entryRelPath: string): string {
	let dir = dirname(fileURLToPath(fromModuleUrl));
	for (;;) {
		const candidate = join(dir, "node_modules", packageName, entryRelPath);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`Cannot resolve ${packageName}/${entryRelPath} from ${fromModuleUrl}`);
		dir = parent;
	}
}

export const PERMISSION_SYSTEM_CONFIG_RELATIVE_PATH = join(
	"extensions",
	"pi-permission-system",
	"config.json",
);

/** Name of the authorizer chain link registered by inno-extension.ts. Must
 *  match the `authorizerChain` entry in the managed default below. */
export const INNO_WEB_AUTHORIZER_NAME = "inno-web";

const MANAGED_DEFAULT = {
	yoloMode: false,
	authorizerChain: [INNO_WEB_AUTHORIZER_NAME],
	permission: {
		"*": "allow",
		bash: {
			"*": "ask",
			// Read-only inspection: auto-allow.
			ls: "allow",
			"ls *": "allow",
			pwd: "allow",
			"cat *": "allow",
			"head *": "allow",
			"tail *": "allow",
			"echo *": "allow",
			"which *": "allow",
			"file *": "allow",
			"wc *": "allow",
			"df *": "allow",
			"du *": "allow",
			"date": "allow",
			"uname *": "allow",
			"git status": "allow",
			"git diff *": "allow",
			"git log *": "allow",
			"git show *": "allow",
			// Destructive / privilege escalation: hard deny (no card).
			"sudo *": "deny",
			"rm -rf /": { action: "deny", reason: "Refusing to delete the filesystem root." },
			"rm -rf ~": { action: "deny", reason: "Refusing to delete the home directory." },
			"rm -rf ~/*": { action: "deny", reason: "Refusing to delete the home directory." },
			"mkfs *": "deny",
			"dd *": "deny",
			"shutdown *": "deny",
			"reboot *": "deny",
		},
		path: {
			"*": "allow",
			"*.env": { action: "deny", reason: ".env files may contain credentials; ask the learner to handle them directly." },
			"*.env.*": { action: "deny", reason: ".env files may contain credentials; ask the learner to handle them directly." },
			"~/.ssh/*": "deny",
			"~/.aws/*": "deny",
			"*.pem": "deny",
			"*.key": "deny",
		},
		// See module docstring §3: asks on this surface can never be approved
		// by a chain link (bounded-delegation downgrade), so the managed default
		// does not generate them.
		external_directory: "allow",
	},
};

/**
 * Write the managed default config if the user has no
 * extensions/pi-permission-system/config.json yet. Never overwrites an
 * existing file.
 */
export function ensurePermissionSystemConfig(configDir: string): void {
	const configPath = join(configDir, PERMISSION_SYSTEM_CONFIG_RELATIVE_PATH);
	try {
		if (existsSync(configPath)) return;
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, JSON.stringify(MANAGED_DEFAULT, null, 2) + "\n", "utf-8");
		logger.info({ configPath }, "wrote managed pi-permission-system default config");
	} catch (err) {
		// Non-fatal: the plugin still loads with its own (least-privilege)
		// defaults; the inno-web authorizer just stays inactive without being
		// named in authorizerChain.
		logger.warn({ err, configPath }, "failed to write pi-permission-system default config");
	}
}
