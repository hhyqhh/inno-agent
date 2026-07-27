import type { ConversationCaptureMode, MeetingStatus, NoteFrontmatter, NoteStatus } from "./types.js";
import { quoteYamlScalar, splitTagText } from "./l2-utils.js";

const FRONTMATTER_PATTERN = /^(?:\uFEFF)?---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseScalar(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function parseTagList(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((tag) => parseScalar(tag.trim()))
			.filter(Boolean);
	}
	return splitTagText(trimmed);
}

export function getTodayRecordDate(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function recordDateFromIso(isoString: string | undefined): string {
	if (!isoString) return getTodayRecordDate();
	const date = new Date(isoString);
	if (Number.isNaN(date.getTime())) return getTodayRecordDate();
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function normalizeRecordDateValue(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
	const slashMatch = trimmed.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
	if (slashMatch) {
		return `${slashMatch[1]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[3].padStart(2, "0")}`;
	}
	const parsed = new Date(trimmed);
	if (!Number.isNaN(parsed.getTime())) return recordDateFromIso(parsed.toISOString());
	return "";
}

export function parseNoteFrontmatter(content: string): { frontmatter: NoteFrontmatter | null; body: string } {
	const match = content.match(FRONTMATTER_PATTERN);
	if (!match) return { frontmatter: null, body: content };

	const yamlBlock = match[1];
	const body = match[2];
	const fm: Record<string, unknown> = {};
	let currentKey = "";
	let currentArray: string[] = [];

	for (const line of yamlBlock.split("\n")) {
		const kvMatch = line.match(/^(\w+):\s*(.*)$/);
		if (kvMatch) {
			if (currentKey && currentArray.length > 0) {
				fm[currentKey] = currentArray;
				currentArray = [];
			}
			currentKey = kvMatch[1];
			const value = kvMatch[2].trim();
			if (value.startsWith("[") && value.endsWith("]")) {
				fm[currentKey] = parseTagList(value);
				currentKey = "";
			} else if (value === "") {
				// array items follow
			} else {
				fm[currentKey] = value;
				currentKey = "";
			}
		} else {
			const itemMatch = line.match(/^\s+-\s+(.+)$/);
			if (itemMatch) {
				currentArray.push(parseScalar(itemMatch[1]));
			}
		}
	}
	if (currentKey && currentArray.length > 0) {
		fm[currentKey] = currentArray;
	}

	const status = fm.status as string;
	const validStatus: NoteStatus =
		status === "indexed" || status === "outdated" || status === "error" ? status : "draft";
	const created = parseScalar(String(fm.created ?? ""));
	const recordDateRaw = parseScalar(String(fm.record_date ?? fm.recordDate ?? ""));
	const rawMeetingStatus = parseScalar(String(fm.meeting_status ?? ""));
	const meetingStatus: MeetingStatus | undefined =
		rawMeetingStatus === "recording" || rawMeetingStatus === "summarizing" || rawMeetingStatus === "completed" ||
		rawMeetingStatus === "connecting" || rawMeetingStatus === "paused" || rawMeetingStatus === "finishing" ||
		rawMeetingStatus === "no_speech" || rawMeetingStatus === "failed" || rawMeetingStatus === "interrupted"
			? rawMeetingStatus
			: undefined;
	const rawCaptureMode = parseScalar(String(fm.capture_mode ?? ""));
	const captureMode: ConversationCaptureMode | undefined =
		rawCaptureMode === "transcript" || rawCaptureMode === "summary" ? rawCaptureMode : undefined;

	return {
		frontmatter: {
			note_id: parseScalar(String(fm.note_id ?? "")),
			title: parseScalar(String(fm.title ?? "")),
			tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : parseTagList(String(fm.tags ?? "")),
			record_date: normalizeRecordDateValue(recordDateRaw) || recordDateFromIso(created),
			status: validStatus,
			meeting_id: fm.meeting_id ? parseScalar(String(fm.meeting_id)) : undefined,
			meeting_status: meetingStatus,
			source_session_id: fm.source_session_id ? parseScalar(String(fm.source_session_id)) : undefined,
			capture_mode: captureMode,
			source_id: fm.source_id ? parseScalar(String(fm.source_id)) : undefined,
			created,
			updated: parseScalar(String(fm.updated ?? "")),
		},
		body,
	};
}

export function serializeNoteFile(frontmatter: NoteFrontmatter, body: string): string {
	const lines = [
		"---",
		`note_id: ${quoteYamlScalar(frontmatter.note_id)}`,
		`title: ${quoteYamlScalar(frontmatter.title)}`,
	];
	if (frontmatter.tags.length > 0) {
		lines.push("tags:");
		for (const tag of frontmatter.tags) {
			lines.push(`  - ${quoteYamlScalar(tag)}`);
		}
	} else {
		lines.push("tags: []");
	}
	lines.push(`record_date: ${quoteYamlScalar(frontmatter.record_date)}`);
	lines.push(`status: ${frontmatter.status}`);
	if (frontmatter.meeting_id) lines.push(`meeting_id: ${quoteYamlScalar(frontmatter.meeting_id)}`);
	if (frontmatter.meeting_status) lines.push(`meeting_status: ${frontmatter.meeting_status}`);
	if (frontmatter.source_session_id) {
		lines.push(`source_session_id: ${quoteYamlScalar(frontmatter.source_session_id)}`);
	}
	if (frontmatter.capture_mode) lines.push(`capture_mode: ${frontmatter.capture_mode}`);
	if (frontmatter.source_id) {
		lines.push(`source_id: ${quoteYamlScalar(frontmatter.source_id)}`);
	}
	lines.push(`created: ${quoteYamlScalar(frontmatter.created)}`);
	lines.push(`updated: ${quoteYamlScalar(frontmatter.updated)}`);
	lines.push("---");
	const trimmedBody = body.replace(/^\n/, "");
	return `${lines.join("\n")}\n${trimmedBody}`;
}

export function extractNoteTitle(body: string, fallback: string): string {
	const match = body.match(/^#\s+(.+)$/m);
	return match?.[1]?.trim() || fallback;
}
