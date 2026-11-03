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
	}),
}));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
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
