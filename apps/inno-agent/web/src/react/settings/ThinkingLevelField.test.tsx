import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InnoThinkingLevel } from "../../types/settings.js";
import { ThinkingLevelField } from "./ThinkingLevelField.js";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
function Form({ enabled = true }: { enabled?: boolean }) {
	const [value, setValue] = useState<InnoThinkingLevel>();
	return <><ThinkingLevelField enabled={enabled} value={value} onChange={setValue} /><output data-testid="value">{value ?? "unset"}</output></>;
}
describe("manual thinking strength", () => {
	it("defaults to no override and allows choosing and clearing a value", () => {
		render(<Form />);
		const select = screen.getByRole("combobox");
		expect((select as HTMLSelectElement).value).toBe("default");
		expect(within(select).getAllByRole("option")).toHaveLength(8);
		fireEvent.change(select, { target: { value: "low" } });
		expect(screen.getByTestId("value").textContent).toBe("low");
		fireEvent.change(select, { target: { value: "default" } });
		expect(screen.getByTestId("value").textContent).toBe("unset");
		expect(screen.getByText("settings.thinking.hint")).toBeTruthy();
	});
	it("disables the optional field unless reasoning support is enabled", () => {
		render(<Form enabled={false} />);
		expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
	});
});
