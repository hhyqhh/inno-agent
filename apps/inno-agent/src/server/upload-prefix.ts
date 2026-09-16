/**
 * Single source of truth for the machine-injected image-upload prefix.
 *
 * The prefix is prepended to fallback prompts in `server/routes/chat.ts`
 * (`prependImagePathsHint`) and stripped back out wherever a session title
 * is derived from the user's first message — here in `server.ts`
 * (`stripInjectedPrefix`) and in the web client at
 * `web/src/react/chat/ChatConversation.tsx` (`firstMessageTitle`), which
 * mirrors this regex. Keep all three in sync when the format changes.
 */
export const UPLOADED_IMAGES_PREFIX_PATTERN = /^\[用户本轮上传了 \d+ 张图片，已保存到工作区：[\s\S]*?\]\s*/;

/** Remove the injected prefix so titles reflect the user's actual words. */
export function stripUploadedImagesPrefix(content: string): string {
	return content.replace(UPLOADED_IMAGES_PREFIX_PATTERN, "").trim();
}
