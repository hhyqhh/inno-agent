import type { ChatToolRecord, QuestionAnswer, QuestionData, QuestionnaireResult } from "../types/chat.js";

export interface AnsweredQuestionnaire {
	questions: QuestionData[];
	result: QuestionnaireResult;
}

/**
 * Recover a completed ask_user_question interaction from either a live tool
 * result ({ content, details }) or the human-readable result stored by older
 * session files. Keeping this conversion outside React makes the history and
 * live-stream render paths behave identically.
 */
export function answeredQuestionnaireFromTool(tool: ChatToolRecord): AnsweredQuestionnaire | null {
	if (tool.toolName !== "ask_user_question") return null;
	const questions = readQuestions(tool.args);
	if (!questions.length) return null;

	const structured = readQuestionnaireResult(tool.result);
	if (structured && !structured.cancelled && structured.answers.length) {
		return { questions, result: structured };
	}

	const text = readResultText(tool.result);
	const answers = text ? readAnswersFromEnvelope(text, questions) : [];
	return answers.length
		? { questions, result: { answers, cancelled: false } }
		: null;
}

function readQuestions(value: unknown): QuestionData[] {
	if (!isRecord(value) || !Array.isArray(value.questions)) return [];
	return value.questions.flatMap((question) => {
		if (!isRecord(question) || typeof question.question !== "string" || !Array.isArray(question.options)) return [];
		const options = question.options.flatMap((option) => {
			if (!isRecord(option) || typeof option.label !== "string") return [];
			return [{
				label: option.label,
				description: typeof option.description === "string" ? option.description : "",
				...(typeof option.preview === "string" ? { preview: option.preview } : {}),
			}];
		});
		return [{
			question: question.question,
			header: typeof question.header === "string" ? question.header : question.question,
			options,
			...(question.multiSelect === true ? { multiSelect: true } : {}),
		}];
	});
}

function readQuestionnaireResult(value: unknown): QuestionnaireResult | null {
	const candidate = isRecord(value) && isRecord(value.details) ? value.details : value;
	if (!isRecord(candidate) || !Array.isArray(candidate.answers)) return null;
	const answers = candidate.answers.flatMap(readAnswer);
	return {
		answers,
		cancelled: candidate.cancelled === true,
		...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
	};
}

function readAnswer(value: unknown): QuestionAnswer[] {
	if (!isRecord(value)
		|| typeof value.questionIndex !== "number"
		|| typeof value.question !== "string"
		|| !["option", "custom", "chat", "multi"].includes(String(value.kind))) return [];
	return [{
		questionIndex: value.questionIndex,
		question: value.question,
		kind: value.kind as QuestionAnswer["kind"],
		answer: typeof value.answer === "string" ? value.answer : null,
		...(Array.isArray(value.selected) ? { selected: value.selected.filter((item): item is string => typeof item === "string") } : {}),
		...(typeof value.notes === "string" ? { notes: value.notes } : {}),
		...(typeof value.preview === "string" ? { preview: value.preview } : {}),
	}];
}

function readResultText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value) || !Array.isArray(value.content)) return "";
	return value.content
		.filter((item): item is Record<string, unknown> => isRecord(item))
		.map((item) => typeof item.text === "string" ? item.text : "")
		.filter(Boolean)
		.join("\n");
}

function readAnswersFromEnvelope(text: string, questions: QuestionData[]): QuestionAnswer[] {
	const answers: QuestionAnswer[] = [];
	questions.forEach((question, questionIndex) => {
		const marker = `"${question.question}"="`;
		const start = text.indexOf(marker);
		if (start < 0) return;
		const valueStart = start + marker.length;
		const valueEnd = text.indexOf('".', valueStart);
		if (valueEnd < 0) return;
		const answer = text.slice(valueStart, valueEnd);
		if (question.multiSelect) {
			answers.push({
				questionIndex,
				question: question.question,
				kind: "multi",
				answer: null,
				selected: answer.split(", ").filter(Boolean),
			});
			return;
		}
		const isKnownOption = question.options.some((option) => option.label === answer);
		answers.push({
			questionIndex,
			question: question.question,
			kind: isKnownOption ? "option" : "custom",
			answer,
		});
	});
	return answers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
