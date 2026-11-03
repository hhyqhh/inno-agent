import { constants as FS_CONSTANTS, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ensureDir, readJson, writeJson, writeText } from "../storage/file-store.js";
import { resolveContainedPath } from "../utils/path-safety.js";
import type { SkillGeneratorMethod } from "./methods.js";

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_CHARS = 64_000;

export interface SkillGeneratorMetadata {
	generator: "inno-skill-generator";
	version: number;
	method: SkillGeneratorMethod;
	createdAt: string;
	updatedAt: string;
	evidence: string[];
	feedback?: string;
	changeSummary?: string;
}

export interface GeneratedSkillSnapshot {
	name: string;
	content: string;
	metadata: SkillGeneratorMetadata | null;
}

export interface SaveGeneratedSkillInput {
	rootDir: string;
	name: string;
	content: string;
	method: SkillGeneratorMethod;
	operation: "create" | "revise";
	confirmed: boolean;
	evidence?: string[];
	feedback?: string;
	changeSummary?: string;
	now?: Date;
}

export interface SaveGeneratedSkillResult {
	name: string;
	filePath: string;
	version: number;
	backupPath?: string;
	metadata: SkillGeneratorMetadata;
}

export function validateSkillName(name: string): string {
	const normalized = name.trim();
	if (!SKILL_NAME_RE.test(normalized) || normalized.length > 64) {
		throw new Error("技能名称必须是 1–64 位小写字母、数字或连字符，例如 research-summary。");
	}
	return normalized;
}

export function validateSkillDocument(content: string, expectedName: string): string {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (!normalized || normalized.length > MAX_SKILL_CHARS) throw new Error(`SKILL.md 不能为空且不能超过 ${MAX_SKILL_CHARS} 字符。`);
	const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) throw new Error("SKILL.md 必须以 YAML frontmatter 开头，并以 --- 结束。");
	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(match[1]);
	} catch (err) {
		throw new Error(`SKILL.md frontmatter 不是有效 YAML：${err instanceof Error ? err.message : String(err)}`);
	}
	if (!frontmatter || typeof frontmatter !== "object") throw new Error("SKILL.md frontmatter 必须是键值对象。");
	const record = frontmatter as Record<string, unknown>;
	if (record.name !== expectedName) throw new Error(`frontmatter 的 name 必须与目录名 ${expectedName} 完全一致。`);
	if (typeof record.description !== "string" || !record.description.trim()) throw new Error("frontmatter 必须包含非空 description，说明何时使用此技能。");
	if (!normalized.slice(match[0].length).trim()) throw new Error("SKILL.md frontmatter 后必须有可执行的正文步骤。");
	return `${normalized}\n`;
}

function contained(rootDir: string, ...parts: string[]): string {
	const path = resolveContainedPath(rootDir, join(...parts));
	if (!path) throw new Error("技能路径未通过安全边界检查。");
	return path;
}

export function inspectGeneratedSkill(rootDir: string, rawName: string): GeneratedSkillSnapshot | null {
	const name = validateSkillName(rawName);
	const filePath = contained(rootDir, name, "SKILL.md");
	if (!existsSync(filePath)) return null;
	const metadataPath = contained(rootDir, name, "generator.json");
	const metadata = existsSync(metadataPath)
		? readJson<SkillGeneratorMetadata | null>(metadataPath, null)
		: null;
	return { name, content: readFileSync(filePath, "utf-8"), metadata };
}

export function saveGeneratedSkill(input: SaveGeneratedSkillInput): SaveGeneratedSkillResult {
	if (!input.confirmed) throw new Error("保存技能前必须获得用户明确确认。");
	const name = validateSkillName(input.name);
	const content = validateSkillDocument(input.content, name);
	ensureDir(input.rootDir);
	const skillDir = contained(input.rootDir, name);
	const filePath = contained(input.rootDir, name, "SKILL.md");
	const exists = existsSync(filePath);
	if (input.operation === "create" && exists) throw new Error(`技能 ${name} 已存在。请改用 evolution + revise，或换一个名称。`);
	if (input.operation === "revise" && !exists) throw new Error(`技能 ${name} 不存在，无法修订。`);

	const now = input.now ?? new Date();
	const timestamp = now.toISOString();
	const previous = exists ? inspectGeneratedSkill(input.rootDir, name)?.metadata : null;
	const previousVersion = typeof previous?.version === "number" && Number.isFinite(previous.version)
		? Math.max(0, Math.floor(previous.version))
		: 0;
	const version = previousVersion + 1;
	let backupPath: string | undefined;

	ensureDir(skillDir);
	if (exists) {
		backupPath = contained(input.rootDir, name, "history", `${timestamp.replace(/[:.]/g, "-")}-v${previousVersion || 1}.md`);
		ensureDir(dirname(backupPath));
		// Never replace an existing backup: a failed backup cancels the overwrite.
		copyFileSync(filePath, backupPath, FS_CONSTANTS.COPYFILE_EXCL);
	}

	const metadata: SkillGeneratorMetadata = {
		generator: "inno-skill-generator",
		version,
		method: input.method,
		createdAt: typeof previous?.createdAt === "string" && previous.createdAt ? previous.createdAt : timestamp,
		updatedAt: timestamp,
		evidence: (input.evidence ?? []).map((item) => item.trim().slice(0, 500)).filter(Boolean).slice(0, 20),
		...(input.feedback?.trim() ? { feedback: input.feedback.trim().slice(0, 2_000) } : {}),
		...(input.changeSummary?.trim() ? { changeSummary: input.changeSummary.trim().slice(0, 1_000) } : {}),
	};
	writeText(filePath, content);
	writeJson(contained(input.rootDir, name, "generator.json"), metadata);
	return { name, filePath, version, backupPath, metadata };
}
