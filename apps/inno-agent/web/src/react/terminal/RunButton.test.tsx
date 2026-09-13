// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunButton } from "./RunButton.js";

afterEach(cleanup);

describe("RunButton", () => {
	it("offers to run runnable files", () => {
		const { container } = render(<RunButton filePath="demo.py" />);
		expect(container.querySelector("button")).not.toBeNull();
	});

	it("renders nothing for files without a run command", () => {
		const { container } = render(<RunButton filePath="notes.md" />);
		expect(container.querySelector("button")).toBeNull();
	});
});
