import { afterEach, expect, it, vi } from "vitest";
import { applyRuntimeEnvironment, resolveRuntimePaths } from "./runtime.js";
import { prependLibreOfficeToPath } from "./office/engine-locator.js";

vi.mock("./office/engine-locator.js", () => ({ prependLibreOfficeToPath: vi.fn() }));
const originalEnv = { ...process.env };
afterEach(() => { process.env = { ...originalEnv }; vi.clearAllMocks(); });

it("waits for the shared engine PATH lookup before startup can consume it", async () => {
	let finish!: (value: string | null) => void;
	vi.mocked(prependLibreOfficeToPath).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
	let ready = false;
	const starting = applyRuntimeEnvironment(resolveRuntimePaths()).then(() => { ready = true; });
	await Promise.resolve();
	expect(ready).toBe(false);
	finish(null);
	await starting;
	expect(ready).toBe(true);
});

it("allows startup without a usable Office engine", async () => {
	vi.mocked(prependLibreOfficeToPath).mockRejectedValue(new Error("not installed"));
	await expect(applyRuntimeEnvironment(resolveRuntimePaths())).resolves.toBeUndefined();
});
