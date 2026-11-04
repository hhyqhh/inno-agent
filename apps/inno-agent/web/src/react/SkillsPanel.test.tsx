// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "./SkillsPanel.js";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { skillsStore } from "../stores/skills-store.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { chatStore } from "../stores/chat-store.js";
import { appStore } from "../stores/app-store.js";

vi.mock("@earendil-works/pi-web-ui", () => ({}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, fallback?: string) => ({
			"skills.generate": "生成技能",
			"skills.generateDesc": "通过引导或轨迹生成技能",
			"skills.tabs.mine": "我的技能",
			"skills.tabs.library": "技能库",
			"skills.tabs.label": "技能来源",
			"skills.searchPlaceholder": "搜索技能",
			"skills.uncategorized": "未分类",
			"skills.mineEmpty": "暂无技能",
			"skills.mineEmptyDesc": "生成或上传技能",
			"skills.upload": "上传",
			"preview.refresh": "刷新",
		} as Record<string, string>)[key] ?? fallback ?? key,
		i18n: { language: "zh-CN" },
	}),
}));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("SkillsPanel generator entry", () => {
	it("starts the guided skill-generator command in the current chat", async () => {
		vi.spyOn(skillsStore, "load").mockResolvedValue();
		const send = vi.spyOn(chatStore, "send").mockResolvedValue();
		const previousSession = sessionsStore.currentSessionId;
		const previousPage = appStore.page;
		sessionsStore.currentSessionId = "current.jsonl";
		chatStore.isSending = false;
		skillsStore.skills = [];
		skillsStore.selectedSkill = null;
		skillsStore.isLoading = false;

		try {
			const { getByRole } = render(<SkillsPanel dndManager={undefined as never} />);
			fireEvent.click(getByRole("button", { name: "生成技能" }));
			await waitFor(() => expect(send).toHaveBeenCalledWith("/skill-create"));
			expect(appStore.page).toBe("chat");
		} finally {
			sessionsStore.currentSessionId = previousSession;
			appStore.setPage(previousPage, "none");
		}
	});
});

describe("SkillsPanel friendly descriptions", () => {
	const docxSkill = {
		name: "docx",
		description: "RAW TECHNICAL DESCRIPTION THAT MUST NOT BE SHOWN",
		enabled: true,
		loaded: true,
		filePath: "/skills/docx/SKILL.md",
		size: 2048,
		updatedAt: "2026-01-01T00:00:00.000Z",
		diagnostics: [],
	};
	const friendlyDescription = "创建、读取和编辑 Word 文档，轻松处理报告与正式文稿。";

	it("shows the polished introduction on cards instead of the raw description", () => {
		vi.spyOn(skillsStore, "load").mockResolvedValue();
		const previousSkills = skillsStore.skills;
		const previousSelected = skillsStore.selectedSkill;
		const previousLoading = skillsStore.isLoading;
		skillsStore.skills = [docxSkill];
		skillsStore.selectedSkill = null;
		skillsStore.isLoading = false;

		try {
			const { getByText, queryByText } = render(<SkillsPanel dndManager={undefined as never} />);
			expect(getByText("Word 文档")).toBeTruthy();
			expect(getByText(friendlyDescription)).toBeTruthy();
			expect(queryByText(docxSkill.name)).toBeNull();
			expect(queryByText(docxSkill.description)).toBeNull();
		} finally {
			skillsStore.skills = previousSkills;
			skillsStore.selectedSkill = previousSelected;
			skillsStore.isLoading = previousLoading;
		}
	});

	it("shows the complete introduction in the skill detail view", async () => {
		vi.stubGlobal("ResizeObserver", class {
			observe() {}
			disconnect() {}
		});
		vi.stubGlobal("matchMedia", vi.fn(() => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})));
		const selectSkill = vi.spyOn(skillsStore, "selectSkill").mockResolvedValue();
		const previousSkills = skillsStore.skills;
		const previousSelected = skillsStore.selectedSkill;
		const previousTree = skillsStore.skillTree;
		const previousLoading = skillsStore.isLoading;
		const previousLoadingTree = skillsStore.isLoadingTree;
		skillsStore.skills = [docxSkill];
		skillsStore.selectedSkill = "docx";
		skillsStore.skillTree = [];
		skillsStore.isLoading = false;
		skillsStore.isLoadingTree = false;

		try {
			const { getByText, queryByText } = render(<SkillsPanel dndManager={undefined as never} />);
			expect(getByText("Word 文档")).toBeTruthy();
			expect(getByText(friendlyDescription)).toBeTruthy();
			expect(queryByText(docxSkill.name)).toBeNull();
			expect(queryByText(docxSkill.description)).toBeNull();
			await waitFor(() => expect(selectSkill).toHaveBeenCalledWith("docx"));
		} finally {
			skillsStore.skills = previousSkills;
			skillsStore.selectedSkill = previousSelected;
			skillsStore.skillTree = previousTree;
			skillsStore.isLoading = previousLoading;
			skillsStore.isLoadingTree = previousLoadingTree;
		}
	});
});
