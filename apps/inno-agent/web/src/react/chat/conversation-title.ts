import type { ChatMessage } from "../../types/chat.js";

/** Header and fullscreen tab must describe the same live conversation. */
export function getConversationTitle(messages: ChatMessage[], title: string | undefined, useTopic: boolean, fallback: string): string {
	if (useTopic && title) return title;
	// Mirror UPLOADED_IMAGES_PREFIX_PATTERN in server/upload-prefix.ts; the
	// frontend cannot import the backend module directly.
	const content = messages.find((message) => message.role === "user")?.content
		.replace(/^\[用户本轮上传了 \d+ 张图片，已保存到工作区：[\s\S]*?\]\s*/, "")
		.replace(/\s+/g, " ").trim();
	return content ? content.length > 28 ? `${content.slice(0, 28)}...` : content : fallback;
}
