// @vitest-environment jsdom
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer.js";
import type { InnoModelInfo } from "../../types/settings.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

const model: InnoModelInfo = {
	id: "test-model", name: "Test model", provider: "test", reasoning: false,
	input: ["text"], contextWindow: 4096, maxTokens: 1024,
};
function props(): ChatComposerProps {
	return {
		inputRef: createRef(), fileInputRef: createRef(), imageInputRef: createRef(),
		mirrorRef: createRef(), hitRef: createRef(), placeholder: "Message", defaultValue: "",
		inlineImages: [], pasteBlocks: [], uploadChips: null,
		modelState: { models: [model], defaultProvider: model.provider, defaultModel: model.id,
			currentModelSupportsNativeImages: false, isSavingModel: false },
		modelOptions: [model], currentModel: model, modelPickerOpen: true, attachMenuOpen: false,
		workspaceFiles: [], smartInputEnabled: false, chatIsSending: false, canReconnect: false,
		isUploading: false, hasSendableContent: false, hasPendingQuestion: false,
		onInput: vi.fn(), onCompositionStart: vi.fn(), onCompositionEnd: vi.fn(), onKeyDown: vi.fn(),
		onPaste: vi.fn(), onFiles: vi.fn(), onImageFiles: vi.fn(), onRemoveInlineImage: vi.fn(),
		onShowPasteInTextField: vi.fn(), onRemovePasteBlock: vi.fn(), onToggleModelPicker: vi.fn(),
		onCloseModelPicker: vi.fn(), onModelSelect: vi.fn(), onOpenModelSettings: vi.fn(),
		onToggleAttachMenu: vi.fn(), onCloseAttachMenu: vi.fn(), onPickWorkspaceFiles: vi.fn(),
		onDropFiles: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onReconnect: vi.fn(),
	};
}

describe("ChatComposer portaled model menu", () => {
	it("inserts a newline without asking the browser to scroll the page on focus", () => {
		const p = props();
		render(<ChatComposer {...p} modelPickerOpen={false} />);
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		const focus = vi.spyOn(textarea, "focus");
		fireEvent.click(screen.getByRole("button", { name: "chat.insertNewline" }));
		expect(textarea.value).toBe("\n");
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		focus.mockRestore();
	});

	it("escapes the composer's overflow clipping parent", () => {
		const { container } = render(<div style={{ overflow: "auto", height: 40 }}><ChatComposer {...props()} /></div>);
		const menu = screen.getByRole("menu", { name: "chat.selectModel" });
		expect(menu.parentElement).toBe(document.body);
		expect(container.contains(menu)).toBe(false);
		expect(menu.style.position).toBe("fixed");
	});

	it("does not dismiss before a portaled option can be selected", () => {
		const p = props();
		render(<ChatComposer {...p} />);
		const option = screen.getByRole("menuitemradio", { name: "Test model" });
		fireEvent.pointerDown(option);
		expect(p.onCloseModelPicker).not.toHaveBeenCalled();
		fireEvent.click(option);
		expect(p.onModelSelect).toHaveBeenCalledWith(model);
		fireEvent.click(screen.getByRole("menuitem", { name: "chat.manageModels" }));
		expect(p.onOpenModelSettings).toHaveBeenCalledTimes(1);
	});

	it("preserves trigger toggling and dismisses on outside pointer / Escape", () => {
		const p = props();
		render(<ChatComposer {...p} />);
		const trigger = screen.getByRole("button", { name: "chat.selectModel" });
		fireEvent.pointerDown(trigger);
		expect(p.onCloseModelPicker).not.toHaveBeenCalled();
		fireEvent.click(trigger);
		expect(p.onToggleModelPicker).toHaveBeenCalledTimes(1);
		fireEvent.pointerDown(document.body);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(p.onCloseModelPicker).toHaveBeenCalledTimes(2);
	});

	it("removes the portal and dismissal listeners when closed", () => {
		const p = props();
		const { rerender } = render(<ChatComposer {...p} />);
		rerender(<ChatComposer {...p} modelPickerOpen={false} />);
		expect(screen.queryByRole("menu")).toBeNull();
		fireEvent.pointerDown(document.body);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(p.onCloseModelPicker).not.toHaveBeenCalled();
	});

	it("does not open an empty menu or allow model changes while sending", () => {
		const p = props();
		const { rerender } = render(<ChatComposer {...p} modelOptions={[]} />);
		expect(screen.queryByRole("menu")).toBeNull();
		rerender(<ChatComposer {...p} chatIsSending />);
		fireEvent.click(screen.getByRole("menuitemradio", { name: "Test model" }));
		expect(p.onModelSelect).not.toHaveBeenCalled();
	});
});
