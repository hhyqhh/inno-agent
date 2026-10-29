import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveContainedPathAsync } from "../utils/path-safety.js";

/** Same bundled/staged layouts as feat/doc-comments, with asynchronous request-time lookup. */
const ENGINE_PATHS: Record<string, string[]> = {
	darwin: ["libreoffice/LibreOffice.app/Contents/MacOS/soffice", "LibreOffice.app/Contents/MacOS/soffice"],
	win32: ["libreoffice/LibreOffice/program/soffice.exe", "LibreOffice/program/soffice.exe"],
	linux: ["libreoffice/program/soffice", "program/soffice"],
};
const SYSTEM_PATHS: Record<string, string[]> = {
	darwin: ["/Applications/LibreOffice.app/Contents/MacOS/soffice", "/opt/homebrew/bin/soffice", "/usr/local/bin/soffice"],
	win32: ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"],
	linux: ["/usr/bin/soffice", "/usr/local/bin/soffice", "/snap/bin/libreoffice"],
};

async function executable(path: string): Promise<boolean> {
	try {
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function findSoffice(stagedRoot = fileURLToPath(new URL(`../../../../vendor/libreoffice/${process.platform}-${process.arch}/`, import.meta.url))): Promise<string | null> {
	const explicit = process.env.INNO_LIBREOFFICE_PATH?.trim();
	if (explicit && await executable(explicit)) return explicit;
	const toolsDir = process.env.INNO_BUNDLED_TOOLS_DIR;
	if (toolsDir) {
		for (const relativePath of ENGINE_PATHS[process.platform] ?? []) {
			const path = await resolveContainedPathAsync(toolsDir, relativePath);
			if (path && await executable(path)) return path;
		}
	}
	// Development previously skipped the staged engine and picked system 26.8.0,
	// whose CJK grid regression doubled the reported document's line spacing.
	for (const relativePath of ENGINE_PATHS[process.platform] ?? []) {
		const path = await resolveContainedPathAsync(stagedRoot, relativePath);
		if (path && await executable(path)) return path;
	}
	for (const path of SYSTEM_PATHS[process.platform] ?? []) {
		if (await executable(path)) return path;
	}
	for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const path = await resolveContainedPathAsync(directory, process.platform === "win32" ? "soffice.exe" : "soffice");
		if (path && await executable(path)) return path;
	}
	return null;
}

export interface OfficeEngine { path: string; fingerprint: string; version: string | null }
const exec = promisify(execFile);

export async function getOfficeEngine(): Promise<OfficeEngine> {
	const path = await findSoffice();
	if (!path) throw new Error("WORD_ENGINE_UNAVAILABLE");
	// Windows' GUI launcher does not provide console output for --version.
	const consolePath = process.platform === "win32" ? await resolveContainedPathAsync(dirname(path), "soffice.com") : null;
	const { stdout } = await exec(consolePath && await executable(consolePath) ? consolePath : path, ["--version"], { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true });
	// tdf#171275: 26.8.0 adds CJK extra leading even when Word's document
	// grid already provides it. 26.8.1 fixes CalcAscent's SnapToGrid check.
	if (/LibreOffice\s+26\.8\.0(?:\.|\s|$)/i.test(stdout)) throw new Error("WORD_ENGINE_INCOMPATIBLE");
	const version = stdout.split("\n", 1)[0]?.trim() || null;
	const info = await stat(path);
	return { path, fingerprint: `${path}\0${stdout.trim()}\0${info.size}:${info.mtimeMs}`, version };
}

/**
 * Prepend the resolved engine's directory to PATH so downstream consumers
 * that do their own lookup — notably @llamaindex/liteparse, which shells out
 * to `which soffice` — find the bundled/explicit copy too. Returns the applied
 * soffice path, or null when no engine was found. Idempotent; called once from
 * applyRuntimeEnvironment (awaited), never per request.
 */
export async function prependLibreOfficeToPath(): Promise<string | null> {
	const soffice = await findSoffice();
	if (!soffice) return null;
	const dir = dirname(soffice);
	const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	if (!entries.includes(dir)) {
		process.env.PATH = [dir, ...entries].join(delimiter);
	}
	return soffice;
}

/**
 * Locate the python interpreter that can drive UNO for a given soffice
 * binary. The UNO bridge must run under LibreOffice's bundled python (it is
 * the only interpreter with a matching pyuno):
 *   - macOS:  <LibreOffice.app>/Contents/Resources/python (wrapper script
 *     that sets PYTHONHOME/PYTHONPATH and execs the framework interpreter)
 *   - win32:  <program>/python.exe next to soffice.exe
 *   - linux:  <program>/python when present (distro packages usually ship
 *     python3-uno for the system python instead — returns null there and the
 *     caller may fall back to system python3 with PYTHONPATH set)
 *
 * macOS caveat: the bundled interpreter binary is signed with a launch
 * constraint and can only be exec'd from LibreOffice's own processes until
 * re-signed — scripts/prepare-libreoffice.sh re-signs it ad hoc at staging
 * time. A user's own /Applications install is NOT re-signed, so the bridge
 * may fail to spawn against system engines on macOS.
 */
export async function findOfficePython(sofficePath: string): Promise<string | null> {
	const dir = dirname(await realpath(sofficePath).catch(() => sofficePath));
	const candidates = process.platform === "darwin"
		// MacOS/soffice -> Contents/Resources/python
		? [join(dir, "..", "Resources", "python")]
		: process.platform === "win32"
			? [join(dir, "python.exe")]
			: [join(dir, "python"), join(dir, "python3")];
	for (const candidate of candidates) {
		if (await executable(candidate)) return candidate;
	}
    if (process.platform === "linux") {
        // Distro packages expose UNO to system python, not a bundled python.
        for (const python of ["/usr/bin/python3", "python3"]) {
            try { await exec(python, ["-c", "import uno"], { timeout: 5_000 }); return python; }
            catch { /* try the next interpreter */ }
        }
    }
    return null;
}
