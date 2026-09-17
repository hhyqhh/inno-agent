// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (_key: string, fallback?: string) => fallback ?? _key,
	}),
}));

import { ChatComposer, type ChatComposerProps } from "./ChatComposer.js";

afterEach(cleanup);

function baseProps(overrides: Partial<ChatComposerProps> = {}): ChatComposerProps {
	return {
		inputRef: createRef<HTMLTextAreaElement>(),
		fileInputRef: createRef<HTMLInputElement>(),
		imageInputRef: createRef<HTMLInputElement>(),
		placeholder: "输入消息",
		defaultValue: "",
		inlineImages: [],
		pasteBlocks: [],
		uploadChips: null,
		modelState: {
			models: [],
			defaultProvider: "p",
			defaultModel: "m",
			currentModelSupportsNativeImages: false,
			isSavingModel: false,
		},
		modelOptions: [],
		modelPickerOpen: false,
		attachMenuOpen: false,
		workspaceFiles: [],
		smartInputEnabled: false,
		mirrorRef: createRef<HTMLDivElement>(),
		hitRef: createRef<HTMLDivElement>(),
		chatIsSending: false,
		canReconnect: false,
		isUploading: false,
		hasSendableContent: false,
		hasPendingQuestion: false,
		onInput: () => undefined,
		onCompositionStart: () => undefined,
		onCompositionEnd: () => undefined,
		onKeyDown: () => undefined,
		onPaste: () => undefined,
		onFiles: () => undefined,
		onImageFiles: () => undefined,
		onRemoveInlineImage: () => undefined,
		onShowPasteInTextField: () => undefined,
		onRemovePasteBlock: () => undefined,
		onToggleModelPicker: () => undefined,
		onCloseModelPicker: () => undefined,
		onModelSelect: () => undefined,
		onOpenModelSettings: () => undefined,
		onToggleAttachMenu: () => undefined,
		onCloseAttachMenu: () => undefined,
		onPickWorkspaceFiles: () => undefined,
		onDropFiles: () => undefined,
		onSend: () => undefined,
		onStop: () => undefined,
		onReconnect: () => undefined,
		...overrides,
	};
}

describe("ChatComposer workspace/permission controls", () => {
	it("does not render the workspace control inside an active conversation", () => {
		render(
			<ChatComposer
				{...baseProps({
					conversationMode: true,
					workspaceControl: <div data-testid="ws-switcher">工作区选择器</div>,
					permissionControl: <div data-testid="perm-control">权限</div>,
				})}
			/>,
		);
		expect(screen.queryByTestId("ws-switcher")).toBeNull();
		expect(screen.getByTestId("perm-control")).toBeTruthy();
	});

	it("keeps both controls on the welcome sub-pill row", () => {
		const { container } = render(
			<ChatComposer
				{...baseProps({
					conversationMode: false,
					workspaceControl: <div data-testid="ws-switcher">工作区选择器</div>,
					permissionControl: <div data-testid="perm-control">权限</div>,
				})}
			/>,
		);
		const subrow = container.querySelector(".inno-composer-subrow");
		expect(subrow?.contains(screen.getByTestId("ws-switcher"))).toBe(true);
		expect(subrow?.contains(screen.getByTestId("perm-control"))).toBe(true);
	});
});
