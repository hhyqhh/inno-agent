import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/index.js";
import type {
	PositionReasonCode,
	ProvenancePayload,
	SourceProvenanceGroup,
	SourceViewerTarget,
	WikiPageType,
} from "../../types/wiki.js";
import { ProvenanceSection } from "./ProvenanceSection.js";

const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;

function readySource(overrides: Partial<Extract<SourceProvenanceGroup, { availability: "ready" }>> = {}): Extract<SourceProvenanceGroup, { availability: "ready" }> {
	return {
		availability: "ready",
		sourceId: "l2src_physics",
		title: "八年级物理教材.pdf",
		sourceType: "pdf",
		origin: "user_upload",
		rawKind: "uploaded-original",
		rawRelativePath: "raw/uploads/physics.pdf",
		sourceRevision: SOURCE_REVISION,
		references: [{
			quote: "同一直线上两个方向相反的力，应先求合力。",
			locator: { kind: "pdf-page", page: 12, block_id: "pdf-p12" },
			selectedBy: "model",
			positionStatus: "verified",
			reasonCodes: [],
		}],
		...overrides,
	};
}

function payload(sourceGroups: SourceProvenanceGroup[], overrides: Partial<ProvenancePayload> = {}): ProvenancePayload {
	return {
		sourceGroups,
		legacyPaths: [],
		referenceIssues: [],
		...overrides,
	};
}

function renderSection(options: {
	provenance?: ProvenancePayload;
	fallbackSources?: string[];
	fallbackSourceIds?: string[];
	onOpenSource?: (target: SourceViewerTarget) => void;
	onRefreshEvidence?: () => void;
	onRemoveStaleEvidence?: () => void;
	mutationPending?: boolean;
	mutationKind?: "refresh" | "remove-stale" | null;
	maintenanceDisabled?: boolean;
	pageType?: WikiPageType;
} = {}) {
	return render(
		<ProvenanceSection
			provenance={options.provenance}
			fallbackSources={options.fallbackSources ?? []}
			fallbackSourceIds={options.fallbackSourceIds ?? []}
			onOpenSource={options.onOpenSource ?? vi.fn()}
			onRefreshEvidence={options.onRefreshEvidence ?? vi.fn()}
			onRemoveStaleEvidence={options.onRemoveStaleEvidence ?? vi.fn()}
			mutationPending={options.mutationPending ?? false}
			mutationKind={options.mutationKind ?? null}
			maintenanceDisabled={options.maintenanceDisabled ?? false}
			pageType={options.pageType}
		/>,
	);
}

beforeEach(async () => {
	await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("ProvenanceSection", () => {
	it("shows a verified PDF reference and emits an exact viewer target", () => {
		const onOpenSource = vi.fn();
		renderSection({ provenance: payload([readySource()]), onOpenSource });

		const summary = screen.getByText("来源与证据");
		const details = summary.closest("details") as HTMLDetailsElement;
		expect(details.open).toBe(false);
		expect(screen.getByText("八年级物理教材.pdf")).toBeTruthy();
		expect(screen.getByText("PDF")).toBeTruthy();
		expect(screen.getByText("raw/uploads/physics.pdf")).toBeTruthy();
		expect(screen.getByText("用户上传")).toBeTruthy();
		expect(screen.getByText("第 12 页")).toBeTruthy();
		expect(screen.getByText("同一直线上两个方向相反的力，应先求合力。")).toBeTruthy();
		expect(screen.getByText("模型选择 · 位置已验证")).toBeTruthy();

		fireEvent.click(summary);
		expect(details.open).toBe(true);
		const open = screen.getByRole("button", { name: /查看原文并定位.*八年级物理教材\.pdf.*第 12 页/ });
		fireEvent.click(open);
		expect(onOpenSource).toHaveBeenCalledWith({
			mode: "exact",
			sourceId: "l2src_physics",
			title: "八年级物理教材.pdf",
			sourceType: "pdf",
			rawKind: "uploaded-original",
			sourceRevision: SOURCE_REVISION,
			quote: "同一直线上两个方向相反的力，应先求合力。",
			locator: { kind: "pdf-page", page: 12, block_id: "pdf-p12" },
			positionStatus: "verified",
			indexVersion: 1,
		});
		expect(document.body.textContent).not.toContain("语义已验证");
		expect(document.body.textContent).not.toContain("人工确认");
	});

	it("does not offer a direct exact action on a source-summary page", () => {
		renderSection({
		pageType: "source-summary",
		provenance: payload([readySource({
			references: [{ ...readySource().references[0], marker: 1 }],
		})]),
	});

	fireEvent.click(screen.getByText("来源与证据"));
		expect(screen.getByText("[1] 第 12 页")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /查看原文并定位/ })).toBeNull();
	});

	it("offers one file-level fallback when a source-summary has no usable markers", () => {
		const onOpenSource = vi.fn();
		const reference = readySource().references[0];
		renderSection({
			pageType: "source-summary",
			provenance: payload([readySource({
				references: [
					{ ...reference, marker: undefined },
					{
						...reference,
						quote: "A second supporting passage.",
						locator: { kind: "pdf-page", page: 13, block_id: "pdf-p13" },
						marker: undefined,
					},
				],
			})]),
			onOpenSource,
		});

		const actions = document.querySelectorAll<HTMLButtonElement>("[data-provenance-action-id]");
		expect(actions).toHaveLength(1);
		fireEvent.click(actions[0]!);
		expect(onOpenSource).toHaveBeenCalledWith({
			mode: "file",
			sourceId: "l2src_physics",
			title: "八年级物理教材.pdf",
			sourceType: "pdf",
			rawKind: "uploaded-original",
			sourceRevision: SOURCE_REVISION,
		});
	});

	it("uses the provenance container width for reference action layout", () => {
		const { container } = renderSection({ provenance: payload([readySource()]) });
		const details = container.querySelector("details");
		const action = screen.getByRole("button", { name: /查看原文并定位/ });
		const referenceRow = action.parentElement;

		expect(details?.classList.contains("@container")).toBe(true);
		expect(referenceRow?.className).toContain("@sm:grid-cols-[minmax(0,1fr)_auto]");
		expect(referenceRow?.className).not.toContain(" sm:grid-cols-[minmax(0,1fr)_auto]");
	});

	it("labels archived Markdown user evidence without claiming human confirmation", () => {
		renderSection({
			provenance: payload([readySource({
				title: "牛顿定律.md",
				sourceType: "markdown",
				rawKind: "archived-text",
				rawRelativePath: "raw/content/law.md",
				references: [{
					quote: "合力决定加速度。",
					locator: { kind: "markdown-block", block_id: "md-2", heading: "第二定律", paragraph: 3 },
					selectedBy: "user",
					positionStatus: "verified",
					reasonCodes: [],
				}],
			})]),
		});

		expect(screen.getByText("Markdown")).toBeTruthy();
		expect(screen.getByText("归档文本")).toBeTruthy();
		expect(screen.getByText("第二定律 · 第 3 段")).toBeTruthy();
		expect(screen.getByText("用户提供 · 位置已验证")).toBeTruthy();
		expect(document.body.textContent).not.toContain("人工确认");
	});

	it("opens a Word source at file level with a neutral legacy acquisition label", () => {
		const onOpenSource = vi.fn();
		renderSection({
			provenance: payload([readySource({
				title: "课堂讲义.docx",
				sourceType: "word",
				rawKind: undefined,
				rawRelativePath: "raw/uploads/lesson.docx",
				references: [],
			})]),
			onOpenSource,
		});

		expect(screen.getByText("Word")).toBeTruthy();
		expect(screen.getByText("本地来源")).toBeTruthy();
		expect(screen.getByText("暂无精确定位")).toBeTruthy();
		const open = screen.getByRole("button", { name: /打开来源.*课堂讲义\.docx.*暂无精确定位/ });
		fireEvent.click(open);
		expect(onOpenSource).toHaveBeenCalledWith({
			mode: "file",
			sourceId: "l2src_physics",
			title: "课堂讲义.docx",
			sourceType: "word",
			sourceRevision: SOURCE_REVISION,
		});
	});

	it.each<[PositionReasonCode, string]>([
		["stale-page", "页面已修改，引用关系待重新确认"],
		["stale-source", "来源已变化"],
		["missing-index", "证据索引缺失"],
		["corrupt-index", "证据索引损坏"],
		["index-version-mismatch", "证据索引版本不兼容"],
		["locator-invalid", "原定位已失效"],
		["quote-mismatch", "未找到原引用"],
		["drifted", "定位已漂移"],
	])("shows the %s degradation without overstating verification", (positionStatus, label) => {
		renderSection({
			provenance: payload([readySource({
				references: [{
					...readySource().references[0],
					positionStatus,
					reasonCodes: [positionStatus],
				}],
			})]),
		});

		expect(screen.getByText(`模型选择 · ${label}`)).toBeTruthy();
		expect(document.body.textContent).not.toContain("语义已验证");
		expect(document.body.textContent).not.toContain("人工确认");
	});

	it("disables missing source and file actions with a visible reason", () => {
		renderSection({
			provenance: payload([
				{
					availability: "missing-source",
					sourceId: "l2src_missing",
					references: [],
				},
				{
					availability: "missing-file",
					sourceId: "l2src_file",
					title: "丢失的资料.md",
					sourceType: "markdown",
					origin: "user_upload",
					rawKind: "uploaded-original",
					rawRelativePath: "raw/uploads/missing.md",
					references: [],
				},
			]),
		});

		expect(screen.getByText("来源记录缺失")).toBeTruthy();
		expect(screen.getByText("来源文件缺失")).toBeTruthy();
		const buttons = screen.getAllByRole("button", { name: /打开来源/ });
		expect(buttons).toHaveLength(2);
		for (const button of buttons) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
			expect(button.getAttribute("aria-describedby")).toBeTruthy();
		}
	});

	it("reports malformed references and independently preserves legacy paths and IDs", () => {
		renderSection({
			provenance: payload([], {
				legacyPaths: ["raw/legacy/path.md"],
				referenceIssues: [{ ordinal: 0, code: "not-object" }],
			}),
			fallbackSources: ["raw/fallback.md"],
			fallbackSourceIds: ["legacy@example.com", "l2src_extra"],
		});

		expect(screen.getByText("1 条引用数据无法解析")).toBeTruthy();
		expect(screen.getByText("raw/legacy/path.md")).toBeTruthy();
		expect(screen.getByText("legacy@example.com")).toBeTruthy();
		expect(screen.getByText("l2src_extra")).toBeTruthy();
	});

	it("falls back to old path and ID lists when provenance is absent", () => {
		renderSection({
			fallbackSources: ["raw/source.md"],
			fallbackSourceIds: ["legacy@example.com"],
		});

		expect(screen.getByText("来源路径")).toBeTruthy();
		expect(screen.getByText("raw/source.md")).toBeTruthy();
		expect(screen.getByText("来源 ID")).toBeTruthy();
		expect(screen.getByText("legacy@example.com")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "刷新引用" })).toBeNull();
	});

	it("renders a quote as inert React text and keeps the accessible location", () => {
		const unsafeQuote = '<img src=x onerror="alert(1)">';
		const { container } = renderSection({
			provenance: payload([readySource({
				references: [{
					...readySource().references[0],
					quote: unsafeQuote,
				}],
			})]),
		});

		expect(screen.getByText(unsafeQuote)).toBeTruthy();
		expect(container.querySelector("img")).toBeNull();
		expect(screen.getByRole("button", { name: /八年级物理教材\.pdf.*第 12 页/ })).toBeTruthy();
	});

	it("emits maintenance actions and disables them while a mutation is pending", () => {
		const onRefreshEvidence = vi.fn();
		const onRemoveStaleEvidence = vi.fn();
		const { rerender } = renderSection({
			provenance: payload([readySource()]),
			onRefreshEvidence,
			onRemoveStaleEvidence,
		});

		fireEvent.click(screen.getByRole("button", { name: "刷新引用" }));
		fireEvent.click(screen.getByRole("button", { name: "移除失效引用" }));
		expect(onRefreshEvidence).toHaveBeenCalledTimes(1);
		expect(onRemoveStaleEvidence).toHaveBeenCalledTimes(1);

		rerender(
			<ProvenanceSection
				provenance={payload([readySource()])}
				fallbackSources={[]}
				fallbackSourceIds={[]}
				onOpenSource={vi.fn()}
				onRefreshEvidence={onRefreshEvidence}
				onRemoveStaleEvidence={onRemoveStaleEvidence}
				mutationPending
				mutationKind="remove-stale"
			/>,
		);
		const refreshButton = screen.getByRole("button", { name: "刷新引用" }) as HTMLButtonElement;
		const removeButton = screen.getByRole("button", { name: "移除失效引用" }) as HTMLButtonElement;
		expect(refreshButton.disabled).toBe(true);
		expect(removeButton.disabled).toBe(true);
		expect(refreshButton.getAttribute("aria-busy")).not.toBe("true");
		expect(removeButton.getAttribute("aria-busy")).toBe("true");
		expect(screen.getByRole("status").textContent).toContain("正在移除失效引用");
	});

	it("uses English labels", async () => {
		await i18n.changeLanguage("en");
		renderSection({ provenance: payload([readySource()]) });

		expect(screen.getByText("Sources & evidence")).toBeTruthy();
		expect(screen.getByText("Model selected · Position verified")).toBeTruthy();
		expect(screen.getByRole("button", { name: /View source and locate.*八年级物理教材/ })).toBeTruthy();
	});
});
