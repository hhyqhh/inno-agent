import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: native.run }));
import { listFileApplications, openFileInApplication } from "./open-with.js";
beforeEach(() => { native.run.mockReset(); });
it("deduplicates application paths, puts the default first, and filters malformed native entries", async () => {
	const apps = [{ id: "/Apps/B.app", name: "B", isDefault: false }, { id: "/Apps/A.app", name: "A", isDefault: true }, { id: "/Apps/B.app", name: "B" }, { id: "relative.app", name: "bad" }];
	native.run.mockImplementation((_cmd, _args, _options, callback) => callback(null, JSON.stringify(apps)));
	expect(await listFileApplications("/work/a.docx", "darwin")).toEqual([{ id: "/Apps/A.app", name: "A", isDefault: true }, { id: "/Apps/B.app", name: "B", isDefault: false }]);
});
it("keeps file names as arguments and never interpolates them into script source", async () => {
	const file = "/work/报告 '; $(touch nope).docx";
	native.run.mockImplementation((_cmd, _args, _options, callback) => callback(null, "[]"));
	await listFileApplications(file, "darwin");
	const [command, args] = native.run.mock.calls[0];
	expect(command).toBe("/usr/bin/osascript");
	expect(args.at(-1)).toBe(file);
	expect(args[3]).not.toContain(file);
	await openFileInApplication(file, "/Apps/Word copy.app");
	expect(native.run.mock.calls[1].slice(0, 2)).toEqual(["/usr/bin/open", ["-a", "/Apps/Word copy.app", file]]);
});
it("provides a default association without platform-specific commands on other desktops", async () => {
	expect(await listFileApplications("C:\\work\\a.docx", "win32")).toEqual([{ id: "system-default", name: "", isDefault: true }]);
	expect(native.run).not.toHaveBeenCalled();
});
it("propagates native failures so the menu can expose a usable default fallback", async () => {
	native.run.mockImplementation((_cmd, _args, _options, callback) => callback(new Error("unavailable")));
	await expect(listFileApplications("/work/a.docx", "darwin")).rejects.toThrow("unavailable");
});

it("preserves native PNG application icons and discards invalid image sources", async () => {
 const icon = "data:image/png;base64,iVBORw0KGgo=";
 native.run.mockImplementation((_cmd, _args, _options, callback) => callback(null, JSON.stringify([
  { id: "/Apps/Word.app", name: "Word", isDefault: true, icon },
  { id: "/Apps/Other.app", name: "Other", icon: "https://example.com/icon.png" },
 ])));
 expect(await listFileApplications("/work/a.docx", "darwin")).toEqual([
  { id: "/Apps/Word.app", name: "Word", isDefault: true, icon },
  { id: "/Apps/Other.app", name: "Other", isDefault: false },
 ]);
});
