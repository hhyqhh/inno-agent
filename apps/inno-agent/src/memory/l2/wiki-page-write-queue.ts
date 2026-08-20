/**
 * Serialize mutations for one Wiki page without imposing a process-wide lock.
 * The queue deliberately treats rejected operations as completed so a failed
 * write cannot poison later edits for the same page.
 */
export class WikiPageWriteQueue {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(path: string, operation: () => Promise<T> | T): Promise<T> {
		const key = normalizeWikiQueueKey(path);
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		this.tails.set(key, current);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.tails.get(key) === current) this.tails.delete(key);
		}
	}
}

function normalizeWikiQueueKey(path: string): string {
	const normalized = path.replace(/\\/gu, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

const queues = new Map<string, WikiPageWriteQueue>();

/** Return the shared page queue for one L2 data root. */
export function getWikiPageWriteQueue(l2DataDir: string): WikiPageWriteQueue {
	let queue = queues.get(l2DataDir);
	if (!queue) {
		queue = new WikiPageWriteQueue();
		queues.set(l2DataDir, queue);
	}
	return queue;
}
