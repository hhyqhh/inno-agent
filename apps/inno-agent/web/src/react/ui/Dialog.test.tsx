import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog.js";

const showModal = vi.fn(function(this: HTMLDialogElement) { this.open = true; });
const show = vi.fn(function(this: HTMLDialogElement) { this.open = true; });
beforeEach(() => {
 Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value: showModal },
  show: { configurable: true, value: show },
  close: { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } },
 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("Dialog", () => {
 it("opens through native showModal", () => {
  render(<Dialog label="Modal" onClose={vi.fn()}>Content</Dialog>);
  expect(showModal).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Modal" }).getAttribute("aria-modal")).toBe("true");
 });
 it("reports the native cancel request (Escape) through onClose", () => {
  const onClose = vi.fn();
  render(<Dialog label="Modal" onClose={onClose}>Content</Dialog>);
  fireEvent(screen.getByRole("dialog"), new Event("cancel"));
  expect(onClose).toHaveBeenCalledOnce();
 });
 it("closes on backdrop clicks only, not on content clicks", () => {
  const onClose = vi.fn();
  render(<Dialog label="Modal" onClose={onClose}><button>Inside</button></Dialog>);
  fireEvent.click(screen.getByRole("button", { name: "Inside" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("dialog"));
  expect(onClose).toHaveBeenCalledOnce();
 });
});
describe("scoped Dialog", () => {
 it("renders in place with show() so CSS can anchor it to the surrounding panel", () => {
  const onClose = vi.fn();
  const { container } = render(<section data-testid="panel"><Dialog scoped label="Panel" onClose={onClose}><button>Confirm</button></Dialog></section>);
  const dialog = screen.getByRole("dialog", { name: "Panel" });
  expect(container.querySelector("[data-testid='panel']")?.contains(dialog)).toBe(true);
  expect(dialog.parentElement).not.toBe(document.body);
  expect(show).toHaveBeenCalledOnce();
  expect(showModal).not.toHaveBeenCalled();
  expect(dialog.getAttribute("tabindex")).toBe("-1");
 });
 it("mirrors showModal modality: outside content turns inert, the host panel stays interactive inside the dialog", () => {
  render(<><button>Outside</button><section data-testid="panel"><button>Panel trigger</button><Dialog scoped label="Panel" onClose={vi.fn()}><button>Confirm</button></Dialog></section></>);
  expect((screen.getByRole("button", { name: "Outside" }) as HTMLElement).inert).toBe(true);
  expect((screen.getByRole("button", { name: "Panel trigger" }) as HTMLElement).inert).toBe(true);
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLElement).inert).toBeFalsy();
 });
 it("restores outside inert states and the previous focus on close", () => {
  const open = <Dialog scoped label="Panel" onClose={vi.fn()}><button>Confirm</button></Dialog>;
  const { unmount, rerender } = render(<><button>Trigger</button></>);
  const trigger = screen.getByRole("button", { name: "Trigger" });
  trigger.focus();
  rerender(<><button>Trigger</button>{open}</>);
  expect((trigger as HTMLElement).inert).toBe(true);
  expect(document.activeElement?.textContent).toBe("Confirm");
  // Removing only the dialog runs the cleanup: inert states and focus return.
  rerender(<><button>Trigger</button></>);
  expect((trigger as HTMLElement).inert).toBeFalsy();
  expect(document.activeElement).toBe(trigger);
  unmount();
 });
 it("closes through Escape unless an unrelated dialog is already open", () => {
  const onClose = vi.fn();
  const { unmount } = render(<Dialog scoped label="Panel" onClose={onClose}><button>Confirm</button></Dialog>);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  unmount();
  const blocked = vi.fn();
  render(<><dialog open><p>Other</p></dialog><Dialog scoped label="Panel" onClose={blocked}><button>Confirm</button></Dialog></>);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(blocked).not.toHaveBeenCalled();
 });
});
