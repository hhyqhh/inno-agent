import { readJson, readJsonAsync, writeJson } from "../storage/file-store.js";
import { collapseInnoSlashCommand } from "../agent/inno-extension.js";
import type { SessionMessageSummary } from "./session-model.js";

/**
 * The runtime expands Inno's Agent commands before the PI SDK persists a user
 * message. Keep the original command in a small session sidecar so the web UI
 * can render the sent message as an atomic command bubble while the model
 * still receives the expanded instruction.
 */
export interface SessionAgentCommandEntry {
	commandContent: string;
	expandedContent: string;
}

export type SessionAgentCommandsMetadata = Record<string, SessionAgentCommandEntry[]>;

let cache: SessionAgentCommandsMetadata | null = null;

function read(dataDir: string): SessionAgentCommandsMetadata {
	if (cache === null) {
		cache = readJson<SessionAgentCommandsMetadata>(agentCommandsMetadataPath(dataDir), {});
	}
	return cache;
}

function write(dataDir: string, metadata: SessionAgentCommandsMetadata): void {
	cache = metadata;
	writeJson(agentCommandsMetadataPath(dataDir), metadata);
}

export function agentCommandsMetadataPath(dataDir: string): string {
	return `${dataDir}/sessions/agent-commands.json`.replaceAll("\\", "/");
}

export function resetAgentCommandStoreForTests(): void {
	cache = null;
}

export function recordSessionAgentCommand(
	dataDir: string,
	sessionId: string,
	entry: SessionAgentCommandEntry,
): void {
	if (!sessionId) return;
	const metadata = { ...read(dataDir) };
	metadata[sessionId] = [...(metadata[sessionId] ?? []), entry];
	write(dataDir, metadata);
}

export function clearSessionAgentCommands(dataDir: string, sessionId: string): void {
	const metadata = read(dataDir);
	if (!(sessionId in metadata)) return;
	const next = { ...metadata };
	delete next[sessionId];
	write(dataDir, next);
}

/**
 * Restore original Agent command text in presentation-facing session
 * messages. Entries are matched FIFO, which keeps repeated identical
 * commands associated with the correct turn and mirrors attachment metadata.
 */
export function mergeSessionAgentCommands(
	dataDir: string,
	sessionId: string,
	messages: SessionMessageSummary[],
): SessionMessageSummary[] {
	return restoreCommands(messages, read(dataDir)[sessionId] ?? []);
}

export async function loadSessionAgentCommandsAsync(dataDir: string): Promise<void> {
	// Share the existing owner/cache; a concurrent synchronous write wins over this read.
	const metadata = cache ?? await readJsonAsync<SessionAgentCommandsMetadata>(agentCommandsMetadataPath(dataDir), {});
	cache ??= metadata;
}

function restoreCommands(messages: SessionMessageSummary[], entries: SessionAgentCommandEntry[]): SessionMessageSummary[] {
	const pending = [...entries];
	return messages.map((message) => {
		if (message.role !== "user") return message;
		const index = pending.findIndex((entry) =>
			entry.expandedContent === message.content || entry.commandContent === message.content,
		);
		if (index !== -1) {
			const [entry] = pending.splice(index, 1);
			return { ...message, content: entry.commandContent };
		}
		const legacyCommand = collapseInnoSlashCommand(message.content);
		return legacyCommand ? { ...message, content: legacyCommand } : message;
	});
}
