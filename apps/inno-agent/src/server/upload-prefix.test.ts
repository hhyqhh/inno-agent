import { describe, expect, it } from "vitest";
import { stripUploadedImagesPrefix } from "./upload-prefix.js";

describe("stripUploadedImagesPrefix", () => {
	it("removes the injected image-upload prefix, including the OCR hint line", () => {
		const prompt = `[用户本轮上传了 2 张图片，已保存到工作区：\n- /ws/a.png\n- /ws/b.png\n如果需要识别图片中的文字（当前模型可能不支持图片识别），请调用 ocr_image 工具并传入上述路径。]\n\n帮我讲讲这张图`;
		expect(stripUploadedImagesPrefix(prompt)).toBe("帮我讲讲这张图");
	});

	it("leaves ordinary prompts untouched", () => {
		expect(stripUploadedImagesPrefix("  什么是贝叶斯定理？ ")).toBe("什么是贝叶斯定理？");
		expect(stripUploadedImagesPrefix("[笔记] 复习计划")).toBe("[笔记] 复习计划");
	});
});
