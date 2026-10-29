import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findOfficePython, findSoffice, getOfficeEngine, prependLibreOfficeToPath } from "./engine-locator.js";

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
		else {
			const engine = await getOfficeEngine();
			expect(engine.fingerprint).toContain(`LibreOffice ${version} build-id`);
			expect(engine.version).toBe(`LibreOffice ${version} build-id`);
		}
	});
});

describe("LibreOffice UNO python and PATH wiring", () => {
	it("locates the bundled UNO python next to the engine", async () => {
		if (process.platform !== "darwin" && process.platform !== "linux") return;
		root = await mkdtemp(join(tmpdir(), "office-locator-"));
		const contents = process.platform === "darwin" ? "LibreOffice.app/Contents" : "program";
		const soffice = process.platform === "darwin"
			? join(root, contents, "MacOS", "soffice")
			: join(root, contents, "soffice");
		await mkdir(join(soffice, ".."), { recursive: true });
		await writeFile(soffice, "test");
		await chmod(soffice, 0o755);
		// darwin: MacOS/soffice -> Contents/Resources/python; linux: python next to soffice
		const python = process.platform === "darwin"
			? join(root, "LibreOffice.app", "Contents", "Resources", "python")
			: join(root, "program", "python");
		await mkdir(join(python, ".."), { recursive: true });
		await writeFile(python, "#!/bin/sh\nexec true\n");
		await chmod(python, 0o755);
		// findOfficePython realpaths the engine (macOS /tmp is a symlink), so
		// the expected python must be resolved the same way.
		const { realpath: realpathAsync } = await import("node:fs/promises");
		expect(await findOfficePython(soffice)).toBe(await realpathAsync(python));
	});

	it("prepends the bundled engine directory to PATH exactly once", async () => {
		root = await mkdtemp(join(tmpdir(), "office-locator-"));
		const relativePath = process.platform === "darwin" ? "libreoffice/LibreOffice.app/Contents/MacOS/soffice"
			: process.platform === "win32" ? "libreoffice/LibreOffice/program/soffice.exe" : "libreoffice/program/soffice";
		const executable = join(root, relativePath);
		await mkdir(join(executable, ".."), { recursive: true });
		await writeFile(executable, "test");
		await chmod(executable, 0o755);
		vi.stubEnv("INNO_LIBREOFFICE_PATH", "");
		vi.stubEnv("INNO_BUNDLED_TOOLS_DIR", root);
		const originalPath = process.env.PATH ?? "";
		vi.stubEnv("PATH", originalPath);
		const first = await prependLibreOfficeToPath();
		expect(first).toBe(executable);
		const engineDir = join(executable, "..");
		expect((process.env.PATH ?? "").split(delimiter)).toContain(engineDir);
		const before = process.env.PATH;
		await prependLibreOfficeToPath();
		expect(process.env.PATH).toBe(before);
		expect((process.env.PATH ?? "").split(delimiter).filter((entry) => entry === engineDir)).toHaveLength(1);
	});
});
import { execFile } from "node:child_process";
