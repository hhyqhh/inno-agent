import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname } from "node:path";
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

export interface OfficeEngine { path: string; fingerprint: string }
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
	const info = await stat(path);
	return { path, fingerprint: `${path}\0${stdout.trim()}\0${info.size}:${info.mtimeMs}` };
}
