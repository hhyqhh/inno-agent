import { describe, expect, it } from "vitest";
import type { ChatToolRecord, QuestionData } from "../types/chat.js";
import {
	answeredQuestionnaireFromTool,
	buildAnsweredQuestionnaireTimeline,
	type AnsweredQuestionnaire,
	type AnsweredQuestionnaireView,
} from "./questionnaire.js";

const questionnaire: AnsweredQuestionnaire = {
	questions: [{
		question: "Choose one",
		header: "Choice",
		options: [{ label: "A", description: "" }],
	}],
	result: {
		answers: [{ questionIndex: 0, question: "Choose one", kind: "option", answer: "A" }],
		cancelled: false,
	},
};

function view(toolCallId: string, contentOffset?: number): AnsweredQuestionnaireView {
	const tool: ChatToolRecord = {
		toolCallId,
		toolName: "ask_user_question",
		args: {},
		...(contentOffset === undefined ? {} : { contentOffset }),
	};
	return { tool, questionnaire };
}

describe("buildAnsweredQuestionnaireTimeline", () => {
	it("keeps a questionnaire between the text produced before and after its tool call", () => {
		const timeline = buildAnsweredQuestionnaireTimeline("beforeafter", [view("question-1", 6)]);

		expect(timeline.entries).toHaveLength(1);
		expect(timeline.entries[0]?.before).toBe("before");
		expect(timeline.tail).toBe("after");
	});

	it("orders multiple questionnaires by their original content offsets", () => {
		const timeline = buildAnsweredQuestionnaireTimeline("one-two-three", [
			view("question-2", 7),
			view("question-1", 3),
		]);

		expect(timeline.entries.map((entry) => [entry.tool.toolCallId, entry.before])).toEqual([
			["question-1", "one"],
			["question-2", "-two"],
		]);
		expect(timeline.tail).toBe("-three");
	});

	it("places legacy questionnaires without an offset after the existing text", () => {
		const timeline = buildAnsweredQuestionnaireTimeline("already shown", [view("legacy")]);

		expect(timeline.entries[0]?.before).toBe("already shown");
		expect(timeline.tail).toBe("");
	});
});

describe("answeredQuestionnaireFromTool", () => {
	const questions: QuestionData[] = [
		{ question: "Pick one", header: "Pick", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
		{ question: "Pick many", header: "Multi", options: [{ label: "X", description: "" }, { label: "Y", description: "" }], multiSelect: true },
	];

	function tool(result: unknown, extra: Partial<ChatToolRecord> = {}): ChatToolRecord {
		return { toolCallId: "question-tool", toolName: "ask_user_question", args: { questions }, result, ...extra };
	}

	it("returns null for errored tools even when the result parses", () => {
		const result = { answers: [{ questionIndex: 0, question: "Pick one", kind: "option", answer: "A" }], cancelled: false };
		expect(answeredQuestionnaireFromTool(tool(result, { isError: true }))).toBeNull();
	});

	it("recovers a structured result from the live { content, details } envelope", () => {
		const details = { answers: [{ questionIndex: 0, question: "Pick one", kind: "option", answer: "B" }], cancelled: false };
		const result = { content: [{ type: "text", text: "User has answered your questions: ..." }], details };

		expect(answeredQuestionnaireFromTool(tool(result))).toEqual({ questions, result: details });
	});

	it("ignores cancelled structured results", () => {
		const result = { answers: [], cancelled: true };
		expect(answeredQuestionnaireFromTool(tool(result))).toBeNull();
	});

	it("parses legacy human-readable envelopes", () => {
		const text = 'User has answered your questions: "Pick one"="A". "Pick many"="X, Y". You can now continue with the user\'s answers in mind.';

		expect(answeredQuestionnaireFromTool(tool(text))).toEqual({
			questions,
			result: {
				cancelled: false,
				answers: [
					{ questionIndex: 0, question: "Pick one", kind: "option", answer: "A" },
					{ questionIndex: 1, question: "Pick many", kind: "multi", answer: null, selected: ["X", "Y"] },
				],
			},
		});
	});

	it("marks legacy answers that match no option as custom", () => {
		const text = 'User has answered your questions: "Pick one"="Something else". You can now continue.';

		const recovered = answeredQuestionnaireFromTool(tool(text));
		expect(recovered?.result.answers).toEqual([
			{ questionIndex: 0, question: "Pick one", kind: "custom", answer: "Something else" },
		]);
	});

	it("returns null when no answer marker matches the questions", () => {
		expect(answeredQuestionnaireFromTool(tool("User declined to answer questions"))).toBeNull();
	});
});
