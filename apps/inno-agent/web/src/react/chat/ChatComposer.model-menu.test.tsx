// @vitest-environment jsdom
import { createRef, useState } from "react";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithTooltipProvider as render } from "../test-utils.js";
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
		expect(document.body.contains(menu)).toBe(true);
		expect(menu.closest("[data-radix-popper-content-wrapper]")).not.toBeNull();
		expect(container.contains(menu)).toBe(false);
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

	it("preserves trigger toggling and dismisses on outside pointer / Escape", async () => {
		const p = props();
		function ControlledComposer() {
			const [open, setOpen] = useState(false);
			return <ChatComposer
				{...p}
				modelPickerOpen={open}
				onToggleModelPicker={() => { p.onToggleModelPicker(); setOpen((value) => !value); }}
				onCloseModelPicker={() => { p.onCloseModelPicker(); setOpen(false); }}
			/>;
		}
		const { container } = render(<ControlledComposer />);
		const trigger = () => container.querySelector<HTMLButtonElement>(".inno-composer-model-trigger")!;
		fireEvent.pointerDown(trigger(), { button: 0, pointerType: "mouse" });
		expect(p.onToggleModelPicker).toHaveBeenCalledTimes(1);
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		fireEvent.pointerDown(container.querySelector(".inno-composer-textarea")!, { button: 0, pointerType: "mouse" });
		expect(p.onCloseModelPicker).toHaveBeenCalledTimes(1);
		fireEvent.pointerDown(trigger(), { button: 0, pointerType: "mouse" });
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
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
