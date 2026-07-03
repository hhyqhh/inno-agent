import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const monoRoot = resolve(__dirname, "../../..");

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

export default defineConfig({
	plugins: [
		stubLmStudioPlugin,
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
		rollupOptions: {
			output: {
				manualChunks: {
					codemirror: [
						"@uiw/react-codemirror",
						"@codemirror/lang-cpp",
						"@codemirror/lang-css",
						"@codemirror/lang-go",
						"@codemirror/lang-html",
						"@codemirror/lang-java",
						"@codemirror/lang-javascript",
						"@codemirror/lang-json",
						"@codemirror/lang-markdown",
						"@codemirror/lang-python",
						"@codemirror/lang-rust",
						"@codemirror/lang-sql",
						"@codemirror/lang-xml",
						"@codemirror/lang-yaml",
					],
					"markdown-editor": ["@uiw/react-md-editor"],
					cytoscape: ["cytoscape", "cytoscape-cola", "cytoscape-cose-bilkent"],
					katex: ["katex"],
					"docx-preview": ["docx-preview"],
					xlsx: ["xlsx"],
				},
			},
		},
	},
});
