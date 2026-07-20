/**
 * OpenAI-compatible embeddings client for L2 wiki vector search.
 *
 * `pi-ai` provides no embedding API (its providers are chat-only), so L2 talks
 * directly to any `/v1/embeddings`-style endpoint via undici. Vectors are
 * L2-normalized so cosine similarity reduces to a dot product downstream.
 *
 * All failures are swallowed into an empty result — embedding is best-effort
 * and must never throw into the archive/query path. When no endpoint is
 * configured, {@link createEmbedder} returns null and vector search is simply
 * off (retrieval degrades to lexical + graph).
 */

import { request } from "undici";
import { logger } from "../../logger.js";
import type { InnoEmbeddingConfig } from "../../config.js";

const REQUEST_TIMEOUT_MS = 30000;
/** Max texts per request — keeps payloads sane for large backfills. */
const BATCH_SIZE = 64;

export interface Embedder {
	readonly model: string;
	/** Embed texts → one L2-normalized vector each; [] on any failure. */
	embed(texts: string[]): Promise<Float32Array[]>;
}

function l2normalize(vec: number[]): Float32Array {
	let norm = 0;
	for (const x of vec) norm += x * x;
	norm = Math.sqrt(norm) || 1;
	const out = new Float32Array(vec.length);
	for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
	return out;
}

/**
 * Build an embedder from config, or null when no embedding endpoint is set.
 */
export function createEmbedder(cfg: InnoEmbeddingConfig | undefined): Embedder | null {
	if (!cfg || !cfg.baseUrl || !cfg.model) return null;
	const endpoint = `${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;

	async function embedBatch(texts: string[]): Promise<Float32Array[]> {
		try {
			const res = await request(endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(cfg!.apiKey ? { authorization: `Bearer ${cfg!.apiKey}` } : {}),
				},
				body: JSON.stringify({ model: cfg!.model, input: texts }),
				headersTimeout: REQUEST_TIMEOUT_MS,
				bodyTimeout: REQUEST_TIMEOUT_MS,
			});
			if (res.statusCode < 200 || res.statusCode >= 300) {
				const body = await res.body.text();
				logger.warn({ status: res.statusCode, body: body.slice(0, 300) }, "[L2] embeddings request failed");
				return [];
			}
			const json = (await res.body.json()) as { data?: { embedding?: number[]; index?: number }[] };
			const data = json.data;
			if (!Array.isArray(data)) return [];
			// Preserve input order (respect `index` if present).
			const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			return ordered.map((d) => l2normalize(Array.isArray(d.embedding) ? d.embedding : []));
		} catch (err) {
			logger.warn({ err }, "[L2] embeddings request error");
			return [];
		}
	}

	return {
		model: cfg.model,
		async embed(texts: string[]): Promise<Float32Array[]> {
			if (texts.length === 0) return [];
			const out: Float32Array[] = [];
			for (let i = 0; i < texts.length; i += BATCH_SIZE) {
				const batch = texts.slice(i, i + BATCH_SIZE);
				const vecs = await embedBatch(batch);
				if (vecs.length !== batch.length) return []; // partial failure → treat as failure
				out.push(...vecs);
			}
			return out;
		},
	};
}
