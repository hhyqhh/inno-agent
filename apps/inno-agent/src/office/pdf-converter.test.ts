import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOfficeEngine } from "./engine-locator.js";
import { OfficePdfConverter } from "./pdf-converter.js";
vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("./engine-locator.js", () => ({ getOfficeEngine: vi.fn() }));
let root: string, converter: OfficePdfConverter, profile: string, fontConfig: string, server: Server | undefined;
let fail = false;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "office-worker-")); converter = new OfficePdfConverter(root); fail = false; fontConfig = "";
	vi.stubEnv("FONTCONFIG_FILE", "");
	vi.spyOn(process, "kill").mockImplementation(() => true);
	vi.mocked(getOfficeEngine).mockResolvedValue({ path: "/test/LibreOffice.app/Contents/MacOS/soffice", fingerprint: "26.8.1", version: "LibreOffice 26.8.1 test" });
	vi.mocked(spawn).mockImplementation(((_path: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
		profile = fileURLToPath(args[0].split("=").slice(1).join("="));
		fontConfig = options.env.FONTCONFIG_FILE ?? "";
		const port = Number(/port=(\d+)/.exec(args.find((a) => a.startsWith("--accept="))!)![1]);
		server = createServer((socket) => socket.end()); server.listen(port, "127.0.0.1");
		void writeFile(args.find((a) => a.startsWith("--pidfile="))!.slice(10), "987654");
		const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: () => { server?.close(); return true; } });
		return child;
	}) as unknown as typeof spawn);
	vi.mocked(execFile).mockImplementation(((path: string, args: string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
		const output = join(args[args.indexOf("--outdir") + 1], "document.pdf");
		void (fail ? Promise.reject(new Error("timeout")) : writeFile(output, "%PDF-1.7\n")).then(() => callback(null, "", ""), (e) => callback(e, "", ""));
		return {};
	}) as typeof execFile);
});
afterEach(async () => { await converter.dispose(); server?.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe("resident Office converter", () => {
	it("shares one initialized engine, private profile and stable font cache across documents", async () => {
		await Promise.all([converter.warm(), converter.warm()]);
		expect(await converter.fingerprint()).toBe("26.8.1"); expect(getOfficeEngine).toHaveBeenCalledTimes(1);
		await converter.convert(Buffer.from("a"), ".doc", join(root, "a.pdf"));
		await converter.convert(Buffer.from("b"), ".docx", join(root, "b.pdf"));
		expect(spawn).toHaveBeenCalledTimes(1); expect(execFile).toHaveBeenCalledTimes(2);
		expect(await readFile(join(profile, "user/registrymodifications.xcu"), "utf8")).toContain("SimSun;Songti SC");
		if (process.platform === "darwin") {
			const config = await readFile(fontConfig, "utf8"); expect(config).toContain("Microsoft Word.app/Contents/Resources/DFonts"); expect(config).toContain(`${root}/font-cache`);
		}
		const args = vi.mocked(execFile).mock.calls[0][1] as string[];
		await expect(stat(args.at(-1)!)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("retires a failed engine before permitting the next conversion", async () => {
		fail = true; await expect(converter.convert(Buffer.from("a"), ".docx", join(root, "a.pdf"))).rejects.toThrow("timeout");
		expect(process.kill).toHaveBeenCalledWith(987654, "SIGTERM");
		fail = false; await converter.convert(Buffer.from("b"), ".docx", join(root, "b.pdf")); expect(spawn).toHaveBeenCalledTimes(2);
	});
	it("allows retry after the engine becomes available and stops on disposal", async () => {
		vi.mocked(getOfficeEngine).mockRejectedValueOnce(new Error("WORD_ENGINE_UNAVAILABLE")); await expect(converter.warm()).rejects.toThrow("WORD_ENGINE_UNAVAILABLE");
		await converter.warm(); await converter.dispose(); expect(process.kill).toHaveBeenCalledWith(987654, "SIGTERM");
		await expect(converter.warm()).rejects.toThrow("Preview service stopped");
	});
});
