// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { settingsStore } from "../../stores/settings-store.js";
import { RunButton } from "./RunButton.js";

afterEach(cleanup);

describe("RunButton", () => {
	it("hides in Simple Mode because the practice terminal is not mounted", () => {
		const previous = settingsStore.settings;
		settingsStore.settings = { simpleMode: { enabled: true } } as typeof previous;
		try {
			const { container } = render(<RunButton filePath="demo.py" />);
			expect(container.querySelector("button")).toBeNull();
		} finally {
			settingsStore.settings = previous;
		}
	});

	it("offers to run runnable files outside Simple Mode", () => {
		const previous = settingsStore.settings;
		settingsStore.settings = { simpleMode: { enabled: false } } as typeof previous;
		try {
			const { container } = render(<RunButton filePath="demo.py" />);
			expect(container.querySelector("button")).not.toBeNull();
		} finally {
			settingsStore.settings = previous;
		}
	});
});
