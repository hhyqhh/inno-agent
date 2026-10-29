import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { handleFontRoutes } from "./fonts.js";

describe("local font routes", () => {
	it("exposes metadata without paths and serves only opaque font ids", async () => {
		const id = "a".repeat(64), writeHead = vi.fn(), end = vi.fn();
		const res = { writeHead, end } as unknown as ServerResponse;
		const fonts = { list: vi.fn().mockResolvedValue([{ family: "SimSun", id }]), read: vi.fn().mockResolvedValue(Buffer.from([0, 1])) };
		expect(await handleFontRoutes(res, "GET", "/api/settings/fonts", fonts)).toBe(true);
		expect(JSON.parse(end.mock.calls[0][0]).faces[0]).toEqual({ family: "SimSun", id });
		expect(await handleFontRoutes(res, "GET", `/api/settings/fonts/${id}`, fonts)).toBe(true);
		expect(fonts.read).toHaveBeenCalledWith(id);
		expect(await handleFontRoutes(res, "GET", "/api/settings/fonts/../../etc/passwd", fonts)).toBe(false);
		expect(await handleFontRoutes(res, "POST", "/api/settings/fonts", fonts)).toBe(false);
	});
	it("returns a 404 for an unavailable catalog entry", async () => {
		const writeHead = vi.fn(), end = vi.fn();
		await handleFontRoutes({ writeHead, end } as unknown as ServerResponse, "GET", `/api/settings/fonts/${"b".repeat(64)}`, { list: vi.fn(), read: vi.fn().mockResolvedValue(null) });
		expect(writeHead).toHaveBeenCalledWith(404, expect.anything());
	});
});
