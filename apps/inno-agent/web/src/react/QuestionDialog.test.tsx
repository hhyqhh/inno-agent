import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithTooltipProvider as render } from "./test-utils.js";
import { QuestionDialog } from "./QuestionDialog.js";
import { AnsweredQuestionCard } from "./chat/AnsweredQuestionCard.js";
import type { PendingQuestion } from "../types/chat.js";

const store = vi.hoisted(() => ({ submitQuestionResponse: vi.fn(), dismissQuestion: vi.fn() }));
vi.mock("../stores/chat-store.js", () => ({ chatStore: store }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const pending: PendingQuestion = {
	questionId: "layout",
	params: { questions: [
		{ header: "页数取舍", question: "希望如何处理页数？", options: [
			{ label: "缩减题量", description: "保持两页" },
			{ label: "保留三页", description: "答题区完整", preview: "第三页保留答题区" },
		] },
		{ header: "配套材料", question: "需要哪些配套材料？", multiSelect: true, options: [
			{ label: "参考答案", description: "包含解题过程" },
			{ label: "评分标准", description: "包含各题分值" },
		] },
	] },
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("uses a labelled multiline answer and keyboard-accessible question tabs", () => {
	render(<QuestionDialog pending={pending} />);
	const input = screen.getByRole("textbox", { name: "question.customAnswer" });
	expect(input.tagName).toBe("TEXTAREA");
	expect(input.getAttribute("rows")).toBe("1");
	expect((screen.getByRole("button", { name: "question.submitNext" }) as HTMLButtonElement).disabled).toBe(true);
	fireEvent.change(input, { target: { value: "保持两页，并增加一道计算题" } });
	fireEvent.keyDown(screen.getByRole("tab", { name: "页数取舍" }), { key: "ArrowRight" });
	expect(screen.getByRole("tab", { name: "配套材料" }).getAttribute("aria-selected")).toBe("true");
	fireEvent.keyDown(screen.getByRole("tab", { name: "配套材料" }), { key: "ArrowLeft" });
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("保持两页，并增加一道计算题");
	fireEvent.change(screen.getByRole("textbox"), { target: { value: " " } });
	expect((screen.getByRole("button", { name: "question.submitNext" }) as HTMLButtonElement).disabled).toBe(true);
});

it("supports single selection, deselection, and returning to a custom draft", () => {
	render(<QuestionDialog pending={pending} />);
	fireEvent.change(screen.getByRole("textbox"), { target: { value: "我的方案" } });
	const option = screen.getByRole("radio", { name: "缩减题量" }) as HTMLInputElement;
	fireEvent.click(option);
	expect(option.checked).toBe(true);
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
	fireEvent.click(screen.getByRole("radio", { name: "保留三页" }));
	expect(option.checked).toBe(false);
	fireEvent.click(screen.getByRole("radio", { name: "保留三页" }));
	expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
	fireEvent.click(screen.getByRole("button", { name: "question.submitNext" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "参考答案" }));
	fireEvent.click(screen.getByRole("button", { name: "question.submit" }));
	expect(store.submitQuestionResponse).toHaveBeenCalledWith("layout", {
		answers: [
			{ questionIndex: 0, question: "希望如何处理页数？", kind: "custom", answer: "我的方案" },
			{ questionIndex: 1, question: "需要哪些配套材料？", kind: "multi", answer: null, selected: ["参考答案"] },
		], cancelled: false,
	});
});

it("keeps multiple selections and gates submission on all questions", () => {
	render(<QuestionDialog pending={pending} />);
	fireEvent.click(screen.getByRole("tab", { name: "配套材料" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "参考答案" }));
	fireEvent.click(screen.getByRole("checkbox", { name: "评分标准" }));
	expect((screen.getByRole("button", { name: "question.submit" }) as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(screen.getByRole("tab", { name: "页数取舍" }));
	fireEvent.click(screen.getByRole("radio", { name: "缩减题量" }));
	fireEvent.click(screen.getByRole("button", { name: "question.submitNext" }));
	expect(screen.getAllByRole("checkbox").every((option) => (option as HTMLInputElement).checked)).toBe(true);
	fireEvent.click(screen.getByRole("checkbox", { name: "评分标准" }));
	fireEvent.click(screen.getByRole("button", { name: "question.submit" }));
	expect(store.submitQuestionResponse.mock.calls[0][1].answers).toContainEqual(expect.objectContaining({ selected: ["参考答案"] }));
});

it("can dismiss the questionnaire from the shared footer action", () => {
	render(<QuestionDialog pending={pending} />);
	fireEvent.click(screen.getByRole("button", { name: "question.chatAboutThis" }));
	expect(store.dismissQuestion).toHaveBeenCalledWith("layout");
	expect(store.submitQuestionResponse).not.toHaveBeenCalled();
});

it("keeps historical answers visible and read-only", () => {
	render(<AnsweredQuestionCard questionnaire={{ questions: pending.params.questions, result: {
		cancelled: false, answers: [{ questionIndex: 0, question: "希望如何处理页数？", kind: "option", answer: "保留三页" }],
	} }} />);
	const option = screen.getByRole("radio", { name: "保留三页" }) as HTMLInputElement;
	expect(option.checked).toBe(true);
	expect(option.disabled).toBe(true);
});

it("keeps archived questions in switchable tabs with each question's saved selection", () => {
	render(<AnsweredQuestionCard questionnaire={{ questions: pending.params.questions, result: {
		cancelled: false, answers: [
			{ questionIndex: 0, question: "希望如何处理页数？", kind: "option", answer: "保留三页" },
			{ questionIndex: 1, question: "需要哪些配套材料？", kind: "multi", answer: null, selected: ["参考答案", "评分标准"] },
		],
	} }} />);
	expect(screen.getAllByRole("tab")).toHaveLength(2);
	expect(screen.queryByRole("checkbox")).toBeNull();
	fireEvent.click(screen.getByRole("tab", { name: "配套材料" }));
	expect(screen.queryByRole("radio")).toBeNull();
	expect(screen.getAllByRole("checkbox").every((option) => (option as HTMLInputElement).checked && (option as HTMLInputElement).disabled)).toBe(true);
	fireEvent.keyDown(screen.getByRole("tab", { name: "配套材料" }), { key: "ArrowLeft" });
	expect((screen.getByRole("radio", { name: "保留三页" }) as HTMLInputElement).checked).toBe(true);
	expect(screen.queryByRole("textbox")).toBeNull();
	expect(screen.queryByRole("button", { name: "question.submit" })).toBeNull();
});

it("shows a saved custom answer only on its archived question tab", () => {
	render(<AnsweredQuestionCard questionnaire={{ questions: pending.params.questions, result: {
		cancelled: false, answers: [
			{ questionIndex: 0, question: "希望如何处理页数？", kind: "option", answer: "缩减题量" },
			{ questionIndex: 1, question: "需要哪些配套材料？", kind: "custom", answer: "附一份学生版" },
		],
	} }} />);
	expect(screen.queryByText("附一份学生版")).toBeNull();
	fireEvent.click(screen.getByRole("tab", { name: "配套材料" }));
	expect(screen.getByText("附一份学生版")).not.toBeNull();
	fireEvent.click(screen.getByRole("tab", { name: "页数取舍" }));
	expect(screen.queryByText("附一份学生版")).toBeNull();
});
