import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import PptxEditor from "./PptxEditor.js";
import type { OfficeEditorHandle } from "./office-editor-handle.js";
import type { WorkspaceFileDetail } from "../../types/workspace.js";

const snapshot = { slides: [] };
vi.mock("./office-ooxml.js", () => ({ preservePptx: vi.fn(async (_original, _baseline, current) => new Uint8Array([current.value])) }));
const file = { path: "deck.pptx", name: "deck.pptx", format: "pptx", url: "/deck?workspaceId=owner" } as WorkspaceFileDetail;
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function setup() {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(3) }));
	const ref = createRef<OfficeEditorHandle>();
	const ready = vi.fn(); const dirty = vi.fn();
	const mounted = render(<PptxEditor ref={ref} file={file} onReadyChange={ready} onInteract={dirty} />);
	const frame = screen.getByTitle("deck.pptx") as HTMLIFrameElement;
	const post = vi.spyOn(frame.contentWindow!, "postMessage");
	const message = async (data: unknown, source: MessageEventSource | null = frame.contentWindow, origin = window.location.origin) => {
		await act(async () => { window.dispatchEvent(new MessageEvent("message", { data, source, origin })); });
	};
	await message({ type: "pptist:ready" });
	expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "pptist:load" }), window.location.origin, expect.any(Array));
	return { ref, ready, dirty, message, post, mounted };
}
it("waits for completed import and accepts immediate changes only from its iframe", async () => {
	const { ready, dirty, message } = await setup();
	expect(ready).not.toHaveBeenCalledWith(true);
	await message({ type: "pptist:loaded", snapshot });
	expect(ready).toHaveBeenCalledWith(true);
	await message({ type: "pptist:change" }, window);
	await message({ type: "pptist:change" }, null, "https://other.example");
	expect(dirty).not.toHaveBeenCalled();
	await message({ type: "pptist:change" });
	expect(dirty).toHaveBeenCalledOnce();
});
it("does not let a late timed-out export satisfy the next save", async () => {
	const { ref, message, post } = await setup();
	await message({ type: "pptist:loaded", snapshot });
	vi.useFakeTimers();
	const first = ref.current!.exportBytes().catch((error) => error);
	const firstId = (post.mock.calls.at(-1)![0] as { requestId: number }).requestId;
	await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
	expect(await first).toBeInstanceOf(Error);
	const second = ref.current!.exportBytes();
	const secondId = (post.mock.calls.at(-1)![0] as { requestId: number }).requestId;
	await message({ type: "pptist:exported", requestId: firstId, snapshot: { ...snapshot, value: 1 } });
	await message({ type: "pptist:exported", requestId: secondId, snapshot: { ...snapshot, value: 2 } });
	expect(await second).toEqual(new Uint8Array([2]));
});
it("settles a pending save when the editor is unmounted", async () => {
	const { ref, message, mounted } = await setup();
	await message({ type: "pptist:loaded", snapshot });
	const saved = ref.current!.exportBytes().catch((error) => error);
	mounted.unmount();
	expect(await saved).toBeInstanceOf(Error);
});
