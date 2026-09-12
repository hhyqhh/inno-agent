import { describe, expect, it } from "vitest";
import { pageFromSearch } from "./app-store.js";

describe("pageFromSearch", () => {
	it("defaults to chat when no params are present", () => {
		expect(pageFromSearch("")).toBe("chat");
		expect(pageFromSearch("?session=abc")).toBe("chat");
	});

	it("reads the ?page= param for valid pages", () => {
		expect(pageFromSearch("?page=notebook")).toBe("notebook");
		expect(pageFromSearch("?page=skills")).toBe("skills");
		expect(pageFromSearch("?page=learner")).toBe("learner");
		expect(pageFromSearch("?page=jobs")).toBe("jobs");
		expect(pageFromSearch("?page=chat")).toBe("chat");
	});

	it("rejects unknown ?page= values", () => {
		expect(pageFromSearch("?page=dashboard")).toBe("chat");
		expect(pageFromSearch("?page=preview")).toBe("chat");
	});

	it("maps legacy ?tab= deep links to pages", () => {
		expect(pageFromSearch("?tab=notebook")).toBe("notebook");
		expect(pageFromSearch("?tab=wiki")).toBe("notebook");
		expect(pageFromSearch("?tab=graph")).toBe("notebook");
		expect(pageFromSearch("?tab=skills")).toBe("skills");
		expect(pageFromSearch("?tab=profile")).toBe("learner");
		expect(pageFromSearch("?tab=jobs")).toBe("jobs");
	});

	it("keeps panel-only tabs on the chat page", () => {
		expect(pageFromSearch("?tab=preview")).toBe("chat");
		expect(pageFromSearch("?tab=settings")).toBe("chat");
	});

	it("?page= wins over ?tab=", () => {
		expect(pageFromSearch("?page=skills&tab=notebook")).toBe("skills");
	});
});
