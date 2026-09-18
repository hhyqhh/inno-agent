// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallbackOrOptions?: string | { defaultValue?: string }, options?: { count?: number }) => {
			const fallback = typeof fallbackOrOptions === "string" ? fallbackOrOptions : fallbackOrOptions?.defaultValue;
			const value = fallback ?? key;
			return options?.count === undefined ? value : value.replace("{{count}}", String(options.count));
		},
	}),
}));

import type { WorkspaceSwitchPreview, WorkspaceSwitchResult } from "../../api/workspaces.js";
import { WorkspaceSwitchConfirm } from "./WorkspaceSwitchConfirm.js";

const preview: WorkspaceSwitchPreview = {
	sourceWorkspace: { id: "source", name: "源工作区", relPath: "source", createdAt: "", updatedAt: "", isTemp: false },
	targetWorkspace: { id: "target", name: "目标工作区", relPath: "target", createdAt: "", updatedAt: "", isTemp: false },
	files: [
		{ path: "notes.md", access: "read_write", exists: true, selectable: true },
		{ path: "missing.md", access: "read", exists: false, selectable: false },
	],
	trackingIncomplete: true,
};

afterEach(cleanup);

const baseProps = () => ({
	preview,
	fileActions: { "notes.md": "none" as const },
	onFileActionChange: vi.fn(),
	onConfirm: vi.fn(),
	onCancel: vi.fn(),
});

describe("WorkspaceSwitchConfirm", () => {
	it("warns about context risk and defaults to the safe switch-only action", () => {
		render(<WorkspaceSwitchConfirm {...baseProps()} />);
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(screen.getByText("源工作区")).toBeTruthy();
		expect(screen.getByText("目标工作区")).toBeTruthy();
		expect(screen.getByText("会话历史会保留，但相同的相对路径可能指向新工作区中的不同文件，可能导致 AI 的上下文或记忆判断错误。此次不会迁移会话历史或记忆。")).toBeTruthy();
		expect(screen.queryByText("当前工作区还被其他会话使用")).toBeNull();
		expect(screen.queryByText("另一个会话")).toBeNull();
		expect(screen.getByText("部分历史文件访问无法可靠还原，文件统计可能不完整。")).toBeTruthy();
		const fileActions = screen.getByRole("radiogroup", { name: "notes.md" });
		expect((within(fileActions).getByRole("radio", { name: "不处理" }) as HTMLInputElement).checked).toBe(true);
		expect(within(fileActions).getByRole("radio", { name: "复制" })).toBeTruthy();
		expect(within(fileActions).getByRole("radio", { name: "移动" })).toBeTruthy();
		expect(screen.queryByRole("checkbox", { name: /notes.md/ })).toBeNull();
	});

	it("renders per-file results after the workspace has switched", () => {
		const result: WorkspaceSwitchResult = {
			switched: true,
			sessionId: "session-1",
			sourceWorkspace: preview.sourceWorkspace,
			targetWorkspace: preview.targetWorkspace,
			files: [{ path: "notes.md", access: "read_write", action: "move", status: "conflict", error: "Target file already exists" }],
			statistics: { success: 0, conflicts: 1, failures: 0, missing: 0, selected: 1 },
			trackingIncomplete: false,
		};
		render(<WorkspaceSwitchConfirm {...baseProps()} result={result} />);
		expect(screen.getByText("工作区已切换")).toBeTruthy();
		fireEvent.click(screen.getByText("查看具体路径"));
		expect(screen.getByText("conflict")).toBeTruthy();
		expect(screen.getByTitle("Target file already exists")).toBeTruthy();
	});
});
