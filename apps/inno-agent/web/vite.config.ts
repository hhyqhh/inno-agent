import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const monoRoot = resolve(__dirname, "../../..");
const COMPRESSIBLE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".html", ".json", ".svg"]);
const HEAVY_LAZY_CHUNK_PATTERNS = [
	"pi-web-ui",
	"PromptDialog",
	"markdown-editor",
	"codemirror",
	"cytoscape",
	"xlsx",
	"docx-preview",
];

function sanitizeUploadName(name: string): string {
	const cleaned = name
		.replace(/[/\\?%*:|"<>]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || "upload";
}

function uploadExtension(fileName: string, mimeType: string): string {
	const ext = extname(fileName);
	if (ext) return ext;
	if (mimeType === "application/pdf") return ".pdf";
	if (mimeType.includes("wordprocessingml")) return ".docx";
	if (mimeType.includes("spreadsheetml")) return ".xlsx";
	if (mimeType.includes("presentationml")) return ".pptx";
	if (mimeType === "text/markdown") return ".md";
	if (mimeType.startsWith("image/")) return `.${mimeType.slice("image/".length).replace("jpeg", "jpg")}`;
	if (mimeType.startsWith("text/")) return ".txt";
	return ".bin";
}

// pi-web-ui depends on @lmstudio/sdk for model discovery,
// but inno-agent does not use LM Studio — stub it out to avoid bundling.
const stubLmStudioPlugin = {
	name: "stub-lmstudio-sdk",
	enforce: "pre" as const,
	resolveId(id: string) {
		if (id === "@lmstudio/sdk") return "\0stub:@lmstudio/sdk";
	},
	load(id: string) {
		if (id === "\0stub:@lmstudio/sdk") return "export const LMStudioClient = class {};";
	},
};

// @mariozechner/mini-lit's MarkdownBlock calls marked.use() inside render(),
// re-registering the same four KaTeX math extensions on the global marked
// instance on every render. The tokenizer chain grows without bound, so every
// markdown parse gets slower the longer the page lives (only a reload resets
// it). Route the call through a once-per-page-load guard, applied as a source
// transform so node_modules stays untouched. Requires the package to be
// excluded from optimizeDeps so dev-mode prebundling doesn't bypass this hook.
const MINILIT_MARKED_GUARD = "__innoRegisterMarkedExtensionsOnce";
const patchMiniLitMarkedPlugin = {
	name: "inno-patch-minilit-marked",
	enforce: "pre" as const,
	transform(code: string, id: string) {
		// Dev-mode ids carry a version query ("MarkdownBlock.js?v=3ef4b778").
		const path = id.split("?", 1)[0];
		if (!path.includes("@mariozechner/mini-lit") || !path.endsWith("MarkdownBlock.js")) return null;
		if (code.includes(MINILIT_MARKED_GUARD)) return null;
		if (code.split("marked.use({").length !== 2) {
			console.warn("[inno-patch-minilit-marked] unexpected marked.use() count in MarkdownBlock.js — leaving upstream code untouched");
			return null;
		}
		const prelude = `function ${MINILIT_MARKED_GUARD}(markedInstance, options) {\n\tif (globalThis.__innoMarkedExtensionsDone) return;\n\tglobalThis.__innoMarkedExtensionsDone = true;\n\tmarkedInstance.use(options);\n}\n`;
		return {
			code: prelude + code.replace("marked.use({", `${MINILIT_MARKED_GUARD}(marked, {`),
			map: null,
		};
	},
};

function precompressStaticAssetsPlugin(thresholdBytes = 10 * 1024): Plugin {
	let resolvedConfig: ResolvedConfig;

	function compressFile(filePath: string): void {
		const ext = extname(filePath);
		if (!COMPRESSIBLE_EXTENSIONS.has(ext) || filePath.endsWith(".br") || filePath.endsWith(".gz")) return;

		const stat = statSync(filePath);
		if (!stat.isFile() || stat.size < thresholdBytes) return;

		const source = readFileSync(filePath);
		const brotli = brotliCompressSync(source, {
			params: {
				[zlibConstants.BROTLI_PARAM_QUALITY]: 11,
			},
		});
		if (brotli.length < source.length) writeFileSync(`${filePath}.br`, brotli);

		const gzip = gzipSync(source, { level: 9 });
		if (gzip.length < source.length) writeFileSync(`${filePath}.gz`, gzip);
	}

	function walk(dir: string): void {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) walk(fullPath);
			else if (entry.isFile()) compressFile(fullPath);
		}
	}

	return {
		name: "inno-precompress-static-assets",
		apply: "build",
		configResolved(config) {
			resolvedConfig = config;
		},
		closeBundle() {
			walk(resolve(resolvedConfig.root, resolvedConfig.build.outDir));
		},
	};
}

export default defineConfig({
	optimizeDeps: {
		// Serve mini-lit as plain ESM so patchMiniLitMarkedPlugin's transform
		// hook sees MarkdownBlock.js in dev mode (prebundled deps skip transforms).
		exclude: ["@mariozechner/mini-lit"],
		// mini-lit is deliberately excluded, but both it and pi-web-ui import
		// highlight.js. Its ESM facade default-imports a CommonJS core module;
		// serving that facade raw makes browsers fail with "does not provide an
		// export named default" when the first assistant Markdown is rendered.
		// Prebundle highlight.js so Vite supplies the required CJS interop wrapper.
		include: [
			"highlight.js",
			"highlight.js/lib/core",
			"highlight.js/lib/languages/bash",
			"highlight.js/lib/languages/css",
			"highlight.js/lib/languages/javascript",
			"highlight.js/lib/languages/json",
			"highlight.js/lib/languages/python",
			"highlight.js/lib/languages/sql",
			"highlight.js/lib/languages/typescript",
			"highlight.js/lib/languages/xml",
		],
	},
	plugins: [
		stubLmStudioPlugin,
		patchMiniLitMarkedPlugin,
		react(),
		{
			name: "link-katex-fonts",
			buildStart() {
				// pi-web-ui's built CSS references url(fonts/KaTeX_...) relative to its dist/.
				// The actual fonts live in node_modules/katex/dist/fonts/.
				// Link the font directory so Vite can resolve it; copy as a fallback
				// when the host filesystem refuses symlink creation.
				const source = resolve(monoRoot, "node_modules/katex/dist/fonts");
				const target = resolve(monoRoot, "node_modules/@earendil-works/pi-web-ui/dist/fonts");
				if (!existsSync(target)) {
					try {
						symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
						cpSync(source, target, { recursive: true });
					}
				}
			},
		},
		{
			name: "inno-dev-upload-api",
			configureServer(server) {
				server.middlewares.use("/api/l2/raw/upload", (req, res, next) => {
					if (req.method !== "POST") {
						next();
						return;
					}

					let raw = "";
					req.on("data", (chunk: Buffer) => {
						raw += chunk.toString();
					});
					req.on("end", () => {
						try {
							const body = JSON.parse(raw || "{}") as Record<string, unknown>;
							const fileName = typeof body.fileName === "string" ? body.fileName : "";
							const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream";
							const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
							if (!fileName || !dataBase64) {
								res.statusCode = 400;
								res.setHeader("Content-Type", "application/json; charset=utf-8");
								res.end(JSON.stringify({ error: "Missing fileName or dataBase64" }));
								return;
							}

							const dir = join(process.cwd(), "..", "data", "l2", "raw", "uploads");
							mkdirSync(dir, { recursive: true });
							const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
							const safeName = sanitizeUploadName(fileName);
							const ext = uploadExtension(safeName, mimeType);
							const base = basename(safeName, ext).slice(0, 80) || "upload";
							const outputName = `${timestamp}-${base}${ext}`;
							const outputPath = join(dir, outputName);
							const data = Buffer.from(dataBase64, "base64");
							writeFileSync(outputPath, data);

							res.statusCode = 201;
							res.setHeader("Content-Type", "application/json; charset=utf-8");
							res.end(JSON.stringify({
								fileName,
								mimeType,
								size: data.length,
								rawPath: join("raw", "uploads", outputName),
							}));
						} catch (err) {
							res.statusCode = 500;
							res.setHeader("Content-Type", "application/json; charset=utf-8");
							res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Upload failed" }));
						}
					});
				});
			},
		},
		precompressStaticAssetsPlugin(),
		tailwindcss(),
	],
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: "http://localhost:3000",
				changeOrigin: true,
				ws: true,
			},
			"/health": "http://localhost:3000",
		},
	},
	build: {
		// The editor and office-preview dependencies are intentionally lazy-loaded
		// and can produce large, standalone chunks. Keep the warning focused on
		// accidental growth of the initial application payload.
		chunkSizeWarningLimit: 2048,
		modulePreload: {
			resolveDependencies: (_filename, deps) => deps.filter((dep) => !HEAVY_LAZY_CHUNK_PATTERNS.some((pattern) => dep.includes(pattern))),
		},
		rollupOptions: {
			output: {
				// Only assign modules that explicitly match manualChunks below.
				// Without this, Rollup merges each matched module's whole dependency
				// subtree into the manual chunk — which dragged mini-lit's
				// MarkdownBlock.js (statically imported by main.tsx for QuestionDialog)
				// into the pi-web-ui chunk, making that 2MB chunk a static dependency
				// of the entry and defeating the lazy loading entirely.
				onlyExplicitManualChunks: true,
				manualChunks(id) {
					if (id.includes("vite/preload-helper")) {
						return "vite-preload-helper";
					}
					if (!id.includes("node_modules")) return undefined;
					if (
						id.includes("/node_modules/@uiw/react-md-editor/") ||
						id.includes("/node_modules/@uiw/react-markdown-preview/")
					) {
						return "markdown-editor";
					}
					// NOTE: @mariozechner/mini-lit is deliberately NOT assigned here.
					// main.tsx statically imports mini-lit/dist/MarkdownBlock.js (needed by
					// QuestionDialog), so forcing all of mini-lit into the pi-web-ui chunk
					// would make that chunk a static dependency of the entry and defeat the
					// lazy loading of pi-web-ui (and its katex/docx-preview/xlsx deps).
					// Leaving mini-lit unassigned lets Rollup put only MarkdownBlock's
					// closure into the entry graph; the rest stays inside the lazy chunk.
					if (
						id.includes("/node_modules/@earendil-works/pi-web-ui/") ||
						id.includes("/node_modules/@juicesharp/")
					) {
						return "pi-web-ui";
					}
					if (id.includes("/node_modules/cytoscape")) {
						return "cytoscape";
					}
					if (id.includes("/node_modules/katex/")) {
						return "katex";
					}
					if (id.includes("/node_modules/docx-preview/")) {
						return "docx-preview";
					}
					if (id.includes("/node_modules/xlsx/")) {
						return "xlsx";
					}
					return undefined;
				},
			},
		},
	},
});
