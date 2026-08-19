import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, type InnoConfig } from "../config.js";

export const DEFAULT_OCR_BASE_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
export const DEFAULT_OCR_MODEL = "PaddleOCR-VL-1.6";

const OPTIONAL_PAYLOAD = {
	useDocOrientationClassify: false,
	useDocUnwarping: false,
	useChartRecognition: false,
};
const POLL_INTERVAL_MS = 3_000;
const MAX_TOTAL_TIMEOUT_MS = 5 * 60_000;

export interface PaddleOcrConfig {
	token: string;
	model: string;
	baseUrl: string;
}

export interface PaddleOcrResult {
	jobId: string;
	markdown: string;
	pages: string[];
}

export class PaddleOcrError extends Error {
	constructor(
		message: string,
		public code:
			| "NOT_CONFIGURED"
			| "FILE_NOT_FOUND"
			| "SUBMIT_FAILED"
			| "JOB_FAILED"
			| "MISSING_RESULT"
			| "EMPTY_RESULT"
			| "ABORTED",
	) {
		super(message);
		this.name = "PaddleOcrError";
	}
}

export function resolvePaddleOcrConfig(config: InnoConfig["ocrApi"] | undefined): PaddleOcrConfig | undefined {
	if (!config?.token.trim()) return undefined;
	return {
		token: config.token.trim(),
		model: config.model?.trim() || DEFAULT_OCR_MODEL,
		baseUrl: config.baseUrl?.trim() || DEFAULT_OCR_BASE_URL,
	};
}

export function loadRuntimePaddleOcrConfig(): PaddleOcrConfig | undefined {
	const configuredPath = process.env.INNO_CONFIG_FILE?.trim();
	const configuredDir = process.env.INNO_CONFIG_DIR?.trim();
	const configPath = configuredPath || (configuredDir ? join(configuredDir, "config.json") : undefined);
	if (!configPath || !existsSync(configPath)) return undefined;
	try {
		return resolvePaddleOcrConfig(loadConfig(configPath).ocrApi);
	} catch {
		return undefined;
	}
}

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `bearer ${token}` };
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

async function submitJob(config: PaddleOcrConfig, input: string, signal: AbortSignal): Promise<string> {
	let response: Response;
	if (isHttpUrl(input)) {
		response = await fetch(config.baseUrl, {
			method: "POST",
			headers: { ...authHeaders(config.token), "Content-Type": "application/json" },
			body: JSON.stringify({ fileUrl: input, model: config.model, optionalPayload: OPTIONAL_PAYLOAD }),
			signal,
		});
	} else {
		if (!existsSync(input) || !statSync(input).isFile()) {
			throw new PaddleOcrError(`找不到图片文件：${input}`, "FILE_NOT_FOUND");
		}
		const form = new FormData();
		form.set("model", config.model);
		form.set("optionalPayload", JSON.stringify(OPTIONAL_PAYLOAD));
		form.set("file", new Blob([new Uint8Array(readFileSync(input))]), basename(input));
		response = await fetch(config.baseUrl, {
			method: "POST",
			headers: authHeaders(config.token),
			body: form,
			signal,
		});
	}

	const text = await response.text();
	if (!response.ok) {
		throw new PaddleOcrError(`OCR 任务提交失败：${response.status} ${text.slice(0, 500)}`, "SUBMIT_FAILED");
	}
	let data: { data?: { jobId?: string } };
	try {
		data = JSON.parse(text) as { data?: { jobId?: string } };
	} catch {
		throw new PaddleOcrError(`OCR 任务返回无效 JSON：${text.slice(0, 300)}`, "SUBMIT_FAILED");
	}
	if (!data.data?.jobId) {
		throw new PaddleOcrError(`OCR 任务未返回 jobId：${text.slice(0, 300)}`, "SUBMIT_FAILED");
	}
	return data.data.jobId;
}

interface JobStatus {
	state: "pending" | "running" | "done" | "failed" | string;
	errorMsg?: string;
	resultUrl?: { jsonUrl?: string };
}

async function pollJob(config: PaddleOcrConfig, jobId: string, signal: AbortSignal): Promise<JobStatus> {
	const response = await fetch(`${config.baseUrl}/${jobId}`, { headers: authHeaders(config.token), signal });
	const text = await response.text();
	if (!response.ok) {
		throw new PaddleOcrError(`OCR 状态查询失败：${response.status} ${text.slice(0, 500)}`, "JOB_FAILED");
	}
	let data: { data?: JobStatus };
	try {
		data = JSON.parse(text) as { data?: JobStatus };
	} catch {
		throw new PaddleOcrError(`OCR 状态响应不是有效 JSON：${text.slice(0, 300)}`, "JOB_FAILED");
	}
	if (!data.data) throw new PaddleOcrError(`OCR 状态响应缺少 data：${text.slice(0, 300)}`, "JOB_FAILED");
	return data.data;
}

async function fetchResult(jsonUrl: string, signal: AbortSignal): Promise<string[]> {
	const response = await fetch(jsonUrl, { signal });
	if (!response.ok) throw new PaddleOcrError(`OCR 结果下载失败：${response.status}`, "MISSING_RESULT");
	const lines = (await response.text()).split("\n").map((line) => line.trim()).filter(Boolean);
	const pages: string[] = [];
	for (const line of lines) {
		let parsed: { result?: { layoutParsingResults?: Array<{ markdown?: { text?: string } }> } };
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		for (const result of parsed.result?.layoutParsingResults ?? []) {
			const markdown = result.markdown?.text?.trim();
			if (markdown) pages.push(markdown);
		}
	}
	return pages;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolveSleep, reject) => {
		const timer = setTimeout(resolveSleep, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new PaddleOcrError("OCR 任务已取消或超时", "ABORTED"));
		}, { once: true });
	});
}

export async function recognizeWithPaddleOcr(
	input: string,
	config: PaddleOcrConfig,
	options: { signal?: AbortSignal } = {},
): Promise<PaddleOcrResult> {
	if (options.signal?.aborted) throw new PaddleOcrError("OCR 任务已取消或超时", "ABORTED");
	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	const totalTimer = setTimeout(abort, MAX_TOTAL_TIMEOUT_MS);

	try {
		const jobId = await submitJob(config, input, controller.signal);
		let status: JobStatus;
		while (true) {
			await sleep(POLL_INTERVAL_MS, controller.signal);
			status = await pollJob(config, jobId, controller.signal);
			if (status.state === "done") break;
			if (status.state === "failed") {
				throw new PaddleOcrError(status.errorMsg || "OCR 任务失败", "JOB_FAILED");
			}
		}

		const jsonUrl = status.resultUrl?.jsonUrl;
		if (!jsonUrl) throw new PaddleOcrError("OCR 任务完成但未返回结果 URL", "MISSING_RESULT");
		const pages = await fetchResult(jsonUrl, controller.signal);
		if (pages.length === 0) throw new PaddleOcrError("OCR 完成，但未识别到文字", "EMPTY_RESULT");
		return { jobId, pages, markdown: pages.join("\n\n---\n\n") };
	} catch (error) {
		if (error instanceof PaddleOcrError) throw error;
		if (controller.signal.aborted) throw new PaddleOcrError("OCR 任务已取消或超时", "ABORTED");
		throw new PaddleOcrError(error instanceof Error ? error.message : String(error), "JOB_FAILED");
	} finally {
		clearTimeout(totalTimer);
		options.signal?.removeEventListener("abort", abort);
	}
}
