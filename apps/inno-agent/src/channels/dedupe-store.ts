import { readJsonl, appendJsonl } from "../storage/file-store.js";

interface DedupeEntry {
	key: string;
	seenAt: string;
	expiresAt: string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class DedupeStore {
	private seen = new Map<string, number>();

	constructor(private filePath: string, private ttlMs = DEFAULT_TTL_MS) {
		const now = Date.now();
		for (const entry of readJsonl<DedupeEntry>(filePath)) {
			const expires = new Date(entry.expiresAt).getTime();
			if (expires > now) {
				this.seen.set(entry.key, expires);
			}
		}
	}

	isDuplicate(channel: string, messageId: string): boolean {
		const key = `${channel}:${messageId}`;
		const expires = this.seen.get(key);
		if (expires && expires > Date.now()) return true;
		return false;
	}

	mark(channel: string, messageId: string): void {
		const key = `${channel}:${messageId}`;
		const now = new Date();
		const expiresAt = new Date(now.getTime() + this.ttlMs);
		this.seen.set(key, expiresAt.getTime());
		appendJsonl(this.filePath, {
			key,
			seenAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
		});
	}

	cleanup(): void {
		const now = Date.now();
		for (const [key, expires] of this.seen) {
			if (expires <= now) this.seen.delete(key);
		}
	}
}
