import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../i18n/index.js";
import type { EvidenceSliceResponse } from "../../../types/wiki.js";
import { PdfSourceView } from "./PdfSourceView.js";

const pdfMocks = vi.hoisted(() => ({
	getDocument: vi.fn(),
	TextLayer: vi.fn(),
	workerSrc: undefined as string | undefined,
}));

vi.mock("pdfjs-dist", () => ({
	getDocument: pdfMocks.getDocument,
	GlobalWorkerOptions: pdfMocks,
	TextLayer: pdfMocks.TextLayer,
}));

const REVISION = `sha256:${"a".repeat(64)}`;

function evidence(): EvidenceSliceResponse {
	return {
		sourceId: "source-pdf",
		sourceRevision: REVISION,
		indexVersion: 1,
		target: { id: "pdf:p002:b001", kind: "pdf", page: 2, text: "The net force determines acceleration." },
		neighbors: [],
	};
}

function pageFixture() {
	const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
	const page = {
		getViewport: vi.fn(() => ({ width: 640, height: 480, scale: 1.25 })),
		getTextContent: vi.fn(async () => ({ items: [{ str: "The net " }, { str: "force determines acceleration." }] })),
		render: vi.fn(() => renderTask),
	};
	const pdf = {
		numPages: 4,
		getPage: vi.fn(async (pageNumber: number) => {
			expect(pageNumber).toBe(2);
			return page;
		}),
		cleanup: vi.fn(),
		destroy: vi.fn(async () => undefined),
	};
	const loadingTask = { promise: Promise.resolve(pdf), destroy: vi.fn(async () => undefined) };
	pdfMocks.getDocument.mockReturnValue(loadingTask);
	pdfMocks.TextLayer.mockImplementation(({ container }: { container: HTMLElement }) => ({
		textDivs: [],
		render: vi.fn(async () => {
			const first = document.createElement("span");
			first.textContent = "The net ";
			const second = document.createElement("span");
			second.textContent = "force determines acceleration.";
			container.append(first, second);
		}),
		cancel: vi.fn(),
	}));
	return { page, pdf, loadingTask, renderTask };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	vi.resetAllMocks();
	Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
		configurable: true,
		value: vi.fn(() => ({
			setTransform: vi.fn(),
			clearRect: vi.fn(),
			drawImage: vi.fn(),
		})),
	});
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("PdfSourceView", () => {
	it("opens only the target page, renders a canvas and a real text layer, and highlights one quote", async () => {
		const fixture = pageFixture();
		const { container } = render(
			<PdfSourceView sourceId="source-pdf" sourceRevision={REVISION} page={2} evidence={evidence()} quote="net force" />,
		);

		await waitFor(() => expect(container.querySelector("canvas")).toBeTruthy());
		expect(pdfMocks.getDocument).toHaveBeenCalledWith(expect.objectContaining({
			url: "/api/l2/sources/source-pdf/content",
			httpHeaders: { "If-Match": `"${REVISION}"` },
			disableRange: false,
			disableStream: true,
			disableAutoFetch: true,
			rangeChunkSize: 64 * 1024,
		}));
		expect(fixture.pdf.getPage).toHaveBeenCalledWith(2);
		expect(fixture.page.render).toHaveBeenCalledOnce();
		expect(container.querySelector(".textLayer")).toBeTruthy();
		expect(container.querySelector("mark[data-pdf-evidence-highlight]")?.textContent).toContain("net ");
		expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
	});

	it("keeps the target page and shows extracted evidence when the PDF text layer cannot map the quote", async () => {
		pageFixture();
		pdfMocks.TextLayer.mockImplementation(({ container }: { container: HTMLElement }) => ({
			render: vi.fn(async () => { container.append(Object.assign(document.createElement("span"), { textContent: "unrelated text" })); }),
			cancel: vi.fn(),
		}));
		const { container } = render(
			<PdfSourceView sourceId="source-pdf" sourceRevision={REVISION} page={2} evidence={evidence()} quote="net force" />,
		);

		expect(await screen.findByText(/visual highlight was unavailable/i)).toBeTruthy();
		expect(container.querySelector("canvas")).toBeTruthy();
		expect(container.querySelector("[data-evidence-text-view]")?.textContent).toContain("net force");
		expect(container.querySelector("[data-evidence-text-view] mark")?.textContent).toBe("net force");
	});

	it("forces the extracted-evidence fallback when quote resolution is unsafe", async () => {
		pageFixture();
		const { container } = render(
			<PdfSourceView
				sourceId="source-pdf"
				sourceRevision={REVISION}
				page={2}
				evidence={evidence()}
				quote="net force"
				forceExtractedFallback
			/>,
		);

		expect(await screen.findByText(/visual highlight was disabled/i)).toBeTruthy();
		expect(container.querySelector("mark[data-pdf-evidence-highlight]")).toBeNull();
		expect(container.querySelector("[data-evidence-text-view] mark")?.textContent).toBe("net force");
	});

	it("localizes the PDF fallback and page label in zh-CN", async () => {
		await i18n.changeLanguage("zh-CN");
		pageFixture();
		render(
			<PdfSourceView
				sourceId="source-pdf"
				sourceRevision={REVISION}
				page={2}
				evidence={evidence()}
				quote="net force"
				forceExtractedFallback
			/>,
		);

		expect(await screen.findByText("因无法安全定位引用，已关闭可视高亮，改为显示抽取的证据。")).toBeTruthy();
		expect(screen.getByLabelText("PDF 第 2 页")).toBeTruthy();
	});

	it("reports preview failures separately from quote-mapping failures", async () => {
		const loadingTask = {
			promise: Promise.reject(new Error("Source revision does not match")),
			destroy: vi.fn(async () => undefined),
		};
		pdfMocks.getDocument.mockReturnValue(loadingTask);
		render(
			<PdfSourceView sourceId="source-pdf" sourceRevision={REVISION} page={2} evidence={evidence()} quote="net force" />,
		);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("PDF preview failed");
		expect(alert.textContent).toContain("Source revision does not match");
		expect(alert.textContent).not.toContain("could not map the quote");
	});

	it("offers the original download when preview fails without extracted evidence", async () => {
		pdfMocks.getDocument.mockReturnValue({
			promise: Promise.reject(new Error("Preview unavailable")),
			destroy: vi.fn(async () => undefined),
		});
		render(<PdfSourceView sourceId="source-pdf" sourceRevision={REVISION} page={2} />);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Download the original file");
		expect(alert.textContent).not.toContain("original page remains visible");
		expect(alert.textContent).not.toContain("Showing extracted evidence instead");
	});

	it("does not promise an extracted fallback when no evidence slice exists", async () => {
		pageFixture();
		pdfMocks.TextLayer.mockImplementation(({ container }: { container: HTMLElement }) => ({
			render: vi.fn(async () => { container.replaceChildren(); }),
			cancel: vi.fn(),
		}));
		render(<PdfSourceView sourceId="source-pdf" sourceRevision={REVISION} page={2} />);

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("no selectable text");
		expect(alert.textContent).not.toContain("Showing extracted evidence instead");
	});

	it("destroys PDF tasks and clears the old page when the target changes", async () => {
		const fixture = pageFixture();
		const { unmount, container } = render(
			<PdfSourceView sourceId="source-pdf" sourceRevision={REVISION} page={2} evidence={evidence()} quote="net force" />,
		);
		await waitFor(() => expect(container.querySelector("canvas")).toBeTruthy());
		unmount();
		expect(fixture.loadingTask.destroy).toHaveBeenCalled();
		expect(fixture.pdf.cleanup).toHaveBeenCalled();
		expect(fixture.pdf.destroy).toHaveBeenCalled();
		expect(fixture.renderTask.cancel).toHaveBeenCalled();
	});

	it("uses byte ranges and repeats the strong If-Match header for every PDF.js request", async () => {
		const bytes = Uint8Array.from(readFileSync("apps/showcase/public/cases/trig-handout/assets/work/final.pdf"));
		const requests: Array<{ range: string | null; ifMatch: string | null }> = [];
		const initialResponseTimers = new Set<ReturnType<typeof setInterval>>();
		let initialBytesSent = 0;
		let initialRequestCancelled = false;
		const server = createServer((request, response) => {
			const range = request.headers.range ?? null;
			const ifMatch = request.headers["if-match"];
			requests.push({ range, ifMatch: typeof ifMatch === "string" ? ifMatch : null });
			if (!range) {
				let offset = 0;
				response.writeHead(200, {
					"Accept-Ranges": "bytes",
					"Content-Length": String(bytes.length),
					"Content-Type": "application/pdf",
					ETag: `"${REVISION}"`,
				});
				const writeChunk = () => {
					if (offset >= bytes.length) {
						response.end();
						return;
					}
					const end = Math.min(offset + 4_096, bytes.length);
					response.write(bytes.subarray(offset, end));
					initialBytesSent += end - offset;
					offset = end;
				};
				writeChunk();
				const timer = setInterval(writeChunk, 20);
				initialResponseTimers.add(timer);
				response.once("close", () => {
					clearInterval(timer);
					initialResponseTimers.delete(timer);
					initialRequestCancelled = !response.writableEnded;
				});
				return;
			}
			const match = /^bytes=(\d+)-(\d+)$/.exec(range);
			if (!match) {
				response.writeHead(416).end();
				return;
			}
			const start = Number(match[1]);
			const end = Math.min(Number(match[2]), bytes.length - 1);
			response.writeHead(206, {
				"Accept-Ranges": "bytes",
				"Content-Length": String(end - start + 1),
				"Content-Range": `bytes ${start}-${end}/${bytes.length}`,
				"Content-Type": "application/pdf",
				ETag: `"${REVISION}"`,
			});
			response.end(bytes.subarray(start, end + 1));
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address() as AddressInfo;
		const originalUint8Array = globalThis.Uint8Array;
		const originalArrayBuffer = globalThis.ArrayBuffer;
		try {
			// Vitest's DOM realm and Node fetch realm use different binary constructors; browsers use one realm.
			const responseProbe = await new Response(originalUint8Array.of(0)).body?.getReader().read();
			if (!responseProbe?.value) throw new Error("Expected Response to expose a binary body");
			globalThis.Uint8Array = responseProbe.value.constructor as Uint8ArrayConstructor;
			globalThis.ArrayBuffer = responseProbe.value.buffer.constructor as ArrayBufferConstructor;
			const actualPdfJs = await vi.importActual<typeof import("pdfjs-dist")>("pdfjs-dist");
			const task = actualPdfJs.getDocument({
				url: `http://127.0.0.1:${address.port}/api/l2/sources/source-pdf/content`,
				httpHeaders: { "If-Match": `"${REVISION}"` },
				disableRange: false,
				disableStream: true,
				disableAutoFetch: true,
				rangeChunkSize: 64 * 1024,
			});

			try {
				const document = await task.promise;
				await document.getPage(2);
				expect(requests[0]?.range).toBeNull();
				expect(requests.some((request) => request.range?.startsWith("bytes=") === true)).toBe(true);
				expect(requests.every((request) => request.ifMatch === `"${REVISION}"`)).toBe(true);
				expect(requests.slice(1).every((request) => request.range !== null)).toBe(true);
				await waitFor(() => expect(initialRequestCancelled).toBe(true));
				expect(initialBytesSent).toBeLessThan(bytes.length);
				await document.destroy();
			} finally {
				await task.destroy();
			}
		} finally {
			globalThis.Uint8Array = originalUint8Array;
			globalThis.ArrayBuffer = originalArrayBuffer;
			for (const timer of initialResponseTimers) clearInterval(timer);
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => error ? reject(error) : resolve());
			});
		}
	});
});
