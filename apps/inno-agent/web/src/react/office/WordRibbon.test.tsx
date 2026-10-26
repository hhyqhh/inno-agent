import type { ReactNode } from "react";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTooltipProvider as render } from "../test-utils.js";
import { WordRibbon } from "./WordRibbon.js";

const engine = vi.hoisted(() => ({ inTable: false, execute: vi.fn(), commandState: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@betteroffice/docx-react", () => {
	const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
	const fontOptions = [
		{ args: { family: "宋体" }, label: "宋体", preview: { fontFamily: "宋体, serif", group: "serif" } },
		{ args: { family: "Times New Roman" }, label: "Times New Roman", preview: { fontFamily: "'Times New Roman', serif", group: "serif" } },
		{ args: { family: "Arial" }, label: "Arial", preview: { fontFamily: "Arial, sans-serif", group: "sans-serif" } },
	];
	return {
		EditorToolbar: Object.assign(Container, { Toolbar: Container }),
		ToolbarCommand: ({ id }: { id: string }) => <button onClick={() => engine.execute(id, null)}>{id}</button>,
		ToolbarCommandSelect: ({ id }: { id: string }) => <span>{id}</span>,
		useDocxCommand: (id: string, args: unknown) => ({ state: { enabled: id !== "tableAction" || engine.inTable }, execute: () => engine.execute(id, args) }),
		useDocxCommands: () => ({ execute: engine.execute }),
		useDocxCommandState: (id: string) => engine.commandState(id) ?? { enabled: true, value: id === "fontFamily" ? "Arial" : null, options: id === "fontFamily" ? fontOptions : [] },
	};
});
const props = { rulers: false, onRulersChange: vi.fn(), outline: false, onOutlineChange: vi.fn(), fontDisplay: null as string | null, onError: vi.fn() };
beforeEach(() => { engine.inTable = false; vi.clearAllMocks(); engine.execute.mockResolvedValue({ ok: true }); engine.commandState.mockReturnValue(null); });
afterEach(cleanup);
describe("BetterOffice ribbon", () => {
 it("keeps seven sections and delegates table availability to the engine", () => {
  const { rerender } = render(<WordRibbon {...props} />);
  expect(screen.getAllByRole("tab")).toHaveLength(7);
  fireEvent.click(screen.getByRole("tab", { name: "wordEditor.tableLayout" }));
  expect((screen.getByRole("button", { name: "wordEditor.insertAbove" }) as HTMLButtonElement).disabled).toBe(true);
  engine.inTable = true; rerender(<WordRibbon {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.insertAbove" }));
  expect(engine.execute).toHaveBeenCalledWith("tableAction", "addRowAbove");
 });
 it("routes page and reference controls to published commands", () => {
  render(<WordRibbon {...props} />);
  fireEvent.click(screen.getByRole("tab", { name: "wordEditor.page" }));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.pageSetup" }));
  expect(engine.execute).toHaveBeenLastCalledWith("pageSetup", null);
  fireEvent.click(screen.getByRole("tab", { name: "wordEditor.references" }));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.toc" }));
  expect(engine.execute).toHaveBeenLastCalledWith("insertTOC", null);
 });
 it("changes view controls without editing document content", () => {
  render(<WordRibbon {...props} />);
  fireEvent.click(screen.getByRole("tab", { name: "wordEditor.view" }));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.outline" }));
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.ruler" }));
  expect(props.onOutlineChange).toHaveBeenCalledOnce(); expect(props.onRulersChange).toHaveBeenCalledOnce();
  expect(engine.execute).not.toHaveBeenCalled();
 });
 it("reports a rejected command rather than claiming it succeeded", async () => {
  engine.execute.mockResolvedValue({ ok: false, failure: { code: "target-changed" } });
  render(<WordRibbon {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "wordEditor.bold" }));
  await vi.waitFor(() => expect(props.onError).toHaveBeenCalledOnce());
 });
 it("shows the host font display so an east-Asian caret does not read as the Latin slot", () => {
  render(<WordRibbon {...props} fontDisplay="宋体" />);
  const trigger = screen.getByRole("combobox", { name: "wordEditor.fontSelector" });
  expect(trigger.textContent).toContain("宋体");
 });
 it("falls back to the engine value when no script-aware display is available", () => {
  render(<WordRibbon {...props} fontDisplay={null} />);
  const trigger = screen.getByRole("combobox", { name: "wordEditor.fontSelector" });
  expect(trigger.textContent).toContain("Arial");
 });
 it("applies the picked family through the engine command", async () => {
  render(<WordRibbon {...props} fontDisplay="宋体" />);
  // Radix needs a pointer-capable element in jsdom to open the dropdown.
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: () => {} });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  const trigger = screen.getByRole("combobox", { name: "wordEditor.fontSelector" });
  trigger.focus();
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("option", { name: "Times New Roman" }));
  await vi.waitFor(() => expect(engine.execute).toHaveBeenCalledWith("fontFamily", { family: "Times New Roman" }));
 });
});
