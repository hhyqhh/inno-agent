import { afterEach, describe, expect, it } from "vitest";
import { isComputerUseEnabled, type InnoConfig } from "../config.js";

function configWith(enabled?: boolean): InnoConfig {
	return {
		defaultProvider: "p",
		defaultModel: "m",
		providers: {},
		plugins: enabled === undefined ? {} : { computerUse: { enabled } },
	} as InnoConfig;
}

describe("isComputerUseEnabled", () => {
	afterEach(() => {
		delete process.env.INNO_DESKTOP;
	});

	it("defaults off without INNO_DESKTOP (server / online deployment)", () => {
		delete process.env.INNO_DESKTOP;
		expect(isComputerUseEnabled(configWith())).toBe(false);
	});

	it("defaults on under the desktop app (INNO_DESKTOP=1)", () => {
		process.env.INNO_DESKTOP = "1";
		expect(isComputerUseEnabled(configWith())).toBe(true);
	});

	it("explicit enabled: true opts in without INNO_DESKTOP (local CLI)", () => {
		delete process.env.INNO_DESKTOP;
		expect(isComputerUseEnabled(configWith(true))).toBe(true);
	});

	it("explicit enabled: false wins even under the desktop app", () => {
		process.env.INNO_DESKTOP = "1";
		expect(isComputerUseEnabled(configWith(false))).toBe(false);
	});
});
