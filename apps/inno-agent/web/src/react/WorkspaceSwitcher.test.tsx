// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";

const workspaces = [
	{ id: "project-1", name: "项目一", relPath: "project-1", createdAt: "", updatedAt: "", isTemp: false },
	{ id: "project-2", name: "项目二", relPath: "project-2", createdAt: "", updatedAt: "", isTemp: false },
	{ id: "tmp", name: "临时工作区", relPath: ".tmp", createdAt: "", updatedAt: "", isTemp: true },
	{ id: "channel-feishu", name: "飞书", relPath: ".channels/feishu", createdAt: "", updatedAt: "", isTemp: false },
];

afterEach(cleanup);

describe("WorkspaceSwitcher conversation mode", () => {
	it("shows existing and temporary workspaces but hides create/import/channel actions", () => {
		const onChange = vi.fn();
		render(
			<WorkspaceSwitcher
				workspaces={workspaces}
				selectedWorkspaceId="project-1"
				selectedKind="workspace"
				conversationMode
				onChange={onChange}
				onImport={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByTitle("workspace.switch"));
		expect(screen.getAllByText("项目一").length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText("项目二")).toBeTruthy();
		expect(screen.getByText("临时工作区")).toBeTruthy();
		expect(screen.queryByText("workspace.newWorkspace")).toBeNull();
		expect(screen.queryByText("workspace.importWorkspace")).toBeNull();
		expect(screen.queryByText("飞书")).toBeNull();
	});

	it("closes without notifying the owner when the current workspace is selected", () => {
		const onChange = vi.fn();
		render(
			<WorkspaceSwitcher
				workspaces={workspaces}
				selectedWorkspaceId="tmp"
				selectedKind="temp"
				conversationMode
				onChange={onChange}
			/>,
		);
		fireEvent.click(screen.getByTitle("workspace.switch"));
		fireEvent.click(screen.getByTitle(".tmp"));
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.queryByRole("menu")).toBeNull();
	});
});
