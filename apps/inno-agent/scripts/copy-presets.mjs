import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../presets");
const target = resolve(here, "../dist/presets");

function copyTree(from, to) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const sourcePath = resolve(from, entry.name);
		const targetPath = resolve(to, entry.name);
		if (entry.isDirectory()) copyTree(sourcePath, targetPath);
		else if (entry.isFile()) copyFileSync(sourcePath, targetPath);
	}
}

if (existsSync(source)) copyTree(source, target);
