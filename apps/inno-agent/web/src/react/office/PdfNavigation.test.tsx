import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import PdfNavigation from "./PdfNavigation.js";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: { number?: number }) => values?.number ? `${key} ${values.number}` : key }) }));
const observers: Array<{ trigger(visible: boolean): void; disconnect: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
	observers.length = 0;
	vi.stubGlobal("IntersectionObserver", class {
		disconnect = vi.fn();
		constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push({ trigger: (visible) => callback([{ isIntersecting: visible }]), disconnect: this.disconnect }); }
		observe() {}
	});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("retains page thumbnails even when the PDF has no outline, and renders only visible thumbnails", async () => {
	const navigate = vi.fn();
	const cancel = vi.fn();
	const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel }));
	const getPage = vi.fn(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render: renderPage }));
	const document = { numPages: 3, getPage } as unknown as PDFDocumentProxy;
	const view = render(<PdfNavigation document={document} outline={[]} page={2} navigate={navigate} navigateOutline={vi.fn()} close={vi.fn()} />);
	expect(screen.getByText("preview.noDocumentOutline")).toBeTruthy();
	fireEvent.click(screen.getByRole("tab", { name: "preview.documentThumbnails" }));
	expect(getPage).not.toHaveBeenCalled();
	expect(screen.getByRole("button", { name: "preview.pageNumber 2" }).getAttribute("aria-current")).toBe("page");
	act(() => observers[0].trigger(true));
	await waitFor(() => expect(renderPage).toHaveBeenCalledOnce());
	expect(getPage).toHaveBeenCalledExactlyOnceWith(1);
	fireEvent.click(screen.getByRole("button", { name: "preview.pageNumber 3" }));
	expect(navigate).toHaveBeenCalledExactlyOnceWith(3);
	view.unmount();
	expect(cancel).toHaveBeenCalledOnce();
	for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledOnce();
});

it("distinguishes loading the outline from a document with no outline", () => {
	render(<PdfNavigation document={{ numPages: 1 } as PDFDocumentProxy} outline={null} page={1} navigate={vi.fn()} navigateOutline={vi.fn()} close={vi.fn()} />);
	expect(screen.getByRole("status").textContent).toBe("preview.loadingFile");
	expect(screen.queryByText("preview.noDocumentOutline")).toBeNull();
});
