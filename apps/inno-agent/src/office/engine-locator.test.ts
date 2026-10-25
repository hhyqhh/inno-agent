import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSoffice, getOfficeEngine } from "./engine-locator.js";

vi.mock("node:child_process", () => {
	const execFile = vi.fn();
	// Match execFile's custom promisifier, which returns both output streams.
	Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: (...args: unknown[]) => new Promise((resolve, reject) => {
		execFile(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
	}) });
	return { execFile };
});

let root: string;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("LibreOffice engine lookup", () => {
	it("prefers the explicit executable over the bundled engine", async () => {
		root = await mkdtemp(join(tmpdir(), "office-locator-"));
		const executable = join(root, "custom-soffice");
		await writeFile(executable, "test");
		await chmod(executable, 0o755);
		vi.stubEnv("INNO_LIBREOFFICE_PATH", executable);
		expect(await findSoffice()).toBe(executable);
	});

	it("finds the packaged engine before system installations", async () => {
		root = await mkdtemp(join(tmpdir(), "office-locator-"));
		const relativePath = process.platform === "darwin" ? "libreoffice/LibreOffice.app/Contents/MacOS/soffice"
			: process.platform === "win32" ? "libreoffice/LibreOffice/program/soffice.exe" : "libreoffice/program/soffice";
		const executable = join(root, relativePath);
		await mkdir(join(executable, ".."), { recursive: true });
		await writeFile(executable, "test");
		await chmod(executable, 0o755);
		vi.stubEnv("INNO_LIBREOFFICE_PATH", "");
		vi.stubEnv("INNO_BUNDLED_TOOLS_DIR", root);
		expect(await findSoffice()).toBe(executable);
	});
	it("uses the staged development engine before an older system installation", async () => {
		root = await mkdtemp(join(tmpdir(), "office-locator-"));
		const relativePath = process.platform === "darwin" ? "LibreOffice.app/Contents/MacOS/soffice"
			: process.platform === "win32" ? "LibreOffice/program/soffice.exe" : "program/soffice";
		const executable = join(root, relativePath);
		await mkdir(join(executable, ".."), { recursive: true }); await writeFile(executable, "test"); await chmod(executable, 0o755);
		vi.stubEnv("INNO_LIBREOFFICE_PATH", ""); vi.stubEnv("INNO_BUNDLED_TOOLS_DIR", "");
		expect(await findSoffice(root)).toBe(executable);
	});
	it.each(["26.8.0.3", "26.8.1.1", "26.8.10.2"])("checks the grid-layout regression in engine %s", async (version) => {
		root = await mkdtemp(join(tmpdir(), "office-locator-"));
		const executable = join(root, "soffice"); await writeFile(executable, "test"); await chmod(executable, 0o755);
		vi.stubEnv("INNO_LIBREOFFICE_PATH", executable);
		vi.mocked(execFile).mockImplementation(((_path: string, _args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
			callback(null, `LibreOffice ${version} build-id\n`, ""); return {};
		}) as typeof execFile);
		if (version === "26.8.0.3") await expect(getOfficeEngine()).rejects.toThrow("WORD_ENGINE_INCOMPATIBLE");
		else expect((await getOfficeEngine()).fingerprint).toContain(`LibreOffice ${version} build-id`);
	});
});
import { execFile } from "node:child_process";
