import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveContainedPathAsync } from "../utils/path-safety.js";
import { getOfficeEngine, type OfficeEngine } from "./engine-locator.js";

const exec = promisify(execFile);

export async function officePath(root: string, relative: string): Promise<string> {
	const path = await resolveContainedPathAsync(root, relative);
	if (!path) throw new Error("Invalid preview storage path");
	return path;
}

function canConnect(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
		socket.setTimeout(200);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.once("timeout", () => finish(false));
	});
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** One warm Office process per preview service, matching Gotenberg's stateful model. */
export class OfficePdfConverter {
	private starting: Promise<void> | null = null;
	private child: ChildProcess | null = null;
	private pid = 0;
	private runtime = "";
	private profile = "";
	private soffice = "";
	private env: NodeJS.ProcessEnv = {};
	private disposed = false;
	private ready = false;
	private generation = 0;
	private jobs = 0;
	private engine: Promise<OfficeEngine> | null = null;

	constructor(private readonly cacheRoot: string) {}

	private resolveEngine(): Promise<OfficeEngine> {
		if (!this.engine) this.engine = getOfficeEngine().catch((error) => { this.engine = null; throw error; });
		return this.engine;
	}
	async fingerprint(): Promise<string> { return (await this.resolveEngine()).fingerprint; }

	async warm(): Promise<void> {
		if (this.disposed) throw new Error("Preview service stopped");
		if (this.ready) {
			try { process.kill(this.pid, 0); return; } catch { this.ready = false; }
		}
		if (!this.starting) this.starting = this.start().finally(() => { this.starting = null; });
		return this.starting;
	}

	private async start(): Promise<void> {
		const generation = this.generation;
		this.jobs = 0;
		this.soffice = (await this.resolveEngine()).path;
		await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
		if (this.runtime) await rm(this.runtime, { recursive: true, force: true });
		this.runtime = await mkdtemp(await officePath(this.cacheRoot, "runtime-"));
		this.profile = `-env:UserInstallation=${pathToFileURL(await officePath(this.runtime, "profile")).href}`;
		this.env = { ...process.env };
		if (process.platform === "darwin" && !this.env.FONTCONFIG_FILE) {
			const config = await officePath(this.runtime, "fonts.conf");
			// The previous scan omitted Word's private fonts, replacing available
			// SimSun/Times New Roman with unrelated fallback faces in exported PDFs.
			const fonts = ["/System/Library/Fonts", "/Library/Fonts",
				"/Applications/Microsoft Word.app/Contents/Resources/DFonts",
				await officePath(homedir(), "Library/Fonts"),
				await officePath(dirname(dirname(this.soffice)), "Resources/fonts")];
			const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
			const cache = await officePath(this.cacheRoot, "font-cache");
			await mkdir(cache, { recursive: true });
			await writeFile(config, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>${fonts.map((path) => `<dir>${escape(path)}</dir>`).join("")}<cachedir>${escape(cache)}</cachedir><alias><family>serif</family><prefer><family>Times New Roman</family><family>SimSun</family><family>Noto Serif CJK SC</family></prefer></alias><alias><family>sans-serif</family><prefer><family>Arial</family><family>Microsoft YaHei</family><family>Noto Sans CJK SC</family></prefer></alias></fontconfig>`);
			this.env.FONTCONFIG_FILE = config;
		}
		// Unspecified East Asian fonts otherwise inherit LibreOffice's own CJK
		// defaults (Source Han Serif in the reported file), rather than Word's
		// common Chinese serif. Explicit document fonts still take precedence.
		const user = await officePath(this.runtime, "profile/user");
		await mkdir(user, { recursive: true });
		const serif = "SimSun;Songti SC;Noto Serif CJK SC;Noto Serif SC";
		await writeFile(await officePath(user, "registrymodifications.xcu"), `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Writer/DefaultFontCJK">${["Standard", "Heading", "List", "Caption", "Index"].map((name) => `<prop oor:name="${name}" oor:op="fuse"><value>${serif}</value></prop>`).join("")}</item>${["en", "zh-cn", "zh-sg"].map((locale) => `<item oor:path="/org.openoffice.VCL/DefaultFonts/${locale}"><prop oor:name="CJK_TEXT" oor:op="fuse"><value>${serif}</value></prop></item>`).join("")}</oor:items>`);
		const pidFile = await officePath(this.runtime, "office.pid");
		const port = await freePort();
		let spawnFailed = false;
		const child = spawn(this.soffice, [this.profile, "--headless", "--nodefault", "--nologo", "--norestore",
			`--pidfile=${pidFile}`, `--accept=socket,host=127.0.0.1,port=${port};urp;StarOffice.ComponentContext`],
		{ env: this.env, stdio: "ignore", windowsHide: true });
		this.child = child;
		child.once("error", () => { spawnFailed = true; });
		child.unref();
		try {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline && !spawnFailed && !this.disposed && generation === this.generation) {
				const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
				if (Number.isInteger(pid) && pid > 1) this.pid = pid;
				if (this.pid && await canConnect(port)) { this.ready = true; return; }
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error("Office preview engine did not become ready");
		} catch (error) {
			const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
			if (Number.isInteger(pid) && pid > 1) this.pid = pid;
			this.stop();
			await rm(this.runtime, { recursive: true, force: true });
			throw error;
		}
	}

	/** Called serially by WordPreviewService; jobs share the initialized font/layout engine. */
	async convert(content: Buffer, extension: string, output: string): Promise<void> {
		await this.warm();
		const job = await mkdtemp(await officePath(this.cacheRoot, "job-"));
		try {
			const source = await officePath(job, `document${extension}`);
			await writeFile(source, content);
			await exec(this.soffice, [this.profile, "--headless", "--convert-to", "pdf:writer_pdf_Export", "--outdir", job, source],
				{ env: this.env, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true });
			await rename(await officePath(job, "document.pdf"), output);
			// Periodically retire the layout engine to bound resident memory growth.
			if (++this.jobs >= 20) this.stop();
		} catch (error) {
			// A timed-out conversion may still be running inside the resident engine.
			// Retire it rather than allowing subsequent jobs to overlap its state.
			this.stop();
			throw error;
		} finally {
			await rm(job, { recursive: true, force: true });
		}
	}

	stop(): void {
		this.generation++;
		this.ready = false;
		if (this.pid) { try { process.kill(this.pid, "SIGTERM"); } catch { /* already exited */ } }
		this.pid = 0;
		this.child?.kill();
		this.child = null;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.stop();
		await this.starting?.catch(() => undefined);
		if (this.runtime) await rm(this.runtime, { recursive: true, force: true });
	}
}
