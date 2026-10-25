import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types/chat.js";
import { getConversationTitle } from "./conversation-title.js";

describe("conversation title shared by header and tab", () => {
	it("uses the deliberate topic or the first user message consistently", () => {
		const messages = [{ role: "user", content: "  First\nquestion " }] as ChatMessage[];
		expect(getConversationTitle(messages, "Topic", true, "New chat")).toBe("Topic");
		expect(getConversationTitle(messages, "Untitled", false, "New chat")).toBe("First question");
		expect(getConversationTitle([], undefined, false, "New chat")).toBe("New chat");
	});
	it("omits the upload wrapper and bounds long titles", () => {
		const content = "[用户本轮上传了 1 张图片，已保存到工作区：\nimage.png]\n" + "a".repeat(40);
		expect(getConversationTitle([{ role: "user", content }] as ChatMessage[], undefined, false, "New chat")).toBe("a".repeat(28) + "...");
	});
});
