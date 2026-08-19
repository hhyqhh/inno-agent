import { afterEach, describe, expect, it, vi } from "vitest";

import {
	recognizeWithPaddleOcr,
	resolvePaddleOcrConfig,
	type PaddleOcrConfig,
} from "./paddle-ocr.js";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("resolvePaddleOcrConfig", () => {
	it("applies defaults and rejects an empty token", () => {
		expect(resolvePaddleOcrConfig({ token: "  " })).toBeUndefined();
		expect(resolvePaddleOcrConfig({ token: " secret " })).toEqual({
			token: "secret",
			model: "PaddleOCR-VL-1.6",
			baseUrl: "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
		});
	});
});

describe("recognizeWithPaddleOcr", () => {
	it("does not submit when the caller has already aborted", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		controller.abort();

		await expect(recognizeWithPaddleOcr("https://files.example/image.png", {
			token: "secret",
			model: "PaddleOCR-VL-1.6",
			baseUrl: "https://ocr.example/jobs",
		}, { signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("submits, polls, and assembles page markdown", async () => {
		vi.useFakeTimers();
		const config: PaddleOcrConfig = {
			token: "secret",
			model: "PaddleOCR-VL-1.6",
			baseUrl: "https://ocr.example/jobs",
		};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url === config.baseUrl && init?.method === "POST") {
				return new Response(JSON.stringify({ data: { jobId: "job-1" } }), { status: 200 });
			}
			if (url === `${config.baseUrl}/job-1`) {
				return new Response(JSON.stringify({
					data: { state: "done", resultUrl: { jsonUrl: "https://ocr.example/result" } },
				}), { status: 200 });
			}
			return new Response([
				JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: "# 第一页" } }] } }),
				JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: "# 第二页" } }] } }),
			].join("\n"), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const resultPromise = recognizeWithPaddleOcr("https://files.example/image.png", config);
		await vi.advanceTimersByTimeAsync(3_000);
		const result = await resultPromise;

		expect(result.jobId).toBe("job-1");
		expect(result.pages).toEqual(["# 第一页", "# 第二页"]);
		expect(result.markdown).toBe("# 第一页\n\n---\n\n# 第二页");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("reports malformed submit responses as a typed error", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
		await expect(recognizeWithPaddleOcr("https://files.example/image.png", {
			token: "secret",
			model: "PaddleOCR-VL-1.6",
			baseUrl: "https://ocr.example/jobs",
		})).rejects.toMatchObject({ code: "SUBMIT_FAILED" });
	});
});
