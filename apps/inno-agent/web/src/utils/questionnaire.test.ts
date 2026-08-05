import { describe, expect, it } from "vitest";
import type { ChatToolRecord } from "../types/chat.js";
import {
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
