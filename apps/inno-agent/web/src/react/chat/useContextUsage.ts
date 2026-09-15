import { useEffect, useRef, useState } from "react";
import { fetchSessionContextUsage, type SessionContextUsage } from "../../api/sessions.js";

export const CONTEXT_USAGE_CACHE_STORAGE_KEY = "inno.contextUsage.summary.v1";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const INACTIVE_RETRY_DELAY_MS = 500;
const MAX_INACTIVE_RETRIES = 12;

type CachedContextUsage = {
	sessionId: string;
	status: "ready";
	source: "sdk" | "estimated";
	tokens: number;
	contextWindow: number;
	percent: number;
	updatedAt: number;
};

function cacheKeyFor(sessionId: string, modelKey?: string) {
	return modelKey ? `${sessionId}:${modelKey}` : sessionId;
}

function readCachedSummary(cacheKey: string, sessionId: string): SessionContextUsage | null {
	if (typeof window === "undefined") return null;
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(CONTEXT_USAGE_CACHE_STORAGE_KEY) ?? "null");
		if (!parsed || typeof parsed !== "object") return null;
		const cached = (parsed as Record<string, unknown>)[cacheKey];
		if (!cached || typeof cached !== "object") return null;
		const item = cached as Partial<CachedContextUsage>;
		const tokens = typeof item.tokens === "number" ? item.tokens : NaN;
		const contextWindow = typeof item.contextWindow === "number" ? item.contextWindow : NaN;
		const percent = typeof item.percent === "number" ? item.percent : NaN;
		const updatedAt = typeof item.updatedAt === "number" ? item.updatedAt : NaN;
		if (item.sessionId !== sessionId || item.status !== "ready" || (item.source !== "sdk" && item.source !== "estimated")
			|| !Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(contextWindow) || contextWindow <= 0
			|| !Number.isFinite(percent) || !Number.isFinite(updatedAt) || Date.now() - updatedAt > CACHE_TTL_MS) return null;
		return {
			sessionId, status: "ready", source: item.source, tokens, contextWindow, percent, breakdown: [],
		};
	} catch {
		return null;
	}
}

function writeCachedSummary(cacheKey: string, data: SessionContextUsage) {
	if (typeof window === "undefined" || data.status !== "ready" || data.tokens === null || data.contextWindow === null || data.percent === null
		|| !Number.isFinite(data.tokens) || !Number.isFinite(data.contextWindow) || !Number.isFinite(data.percent)) return;
	try {
		const parsed: unknown = JSON.parse(window.localStorage.getItem(CONTEXT_USAGE_CACHE_STORAGE_KEY) ?? "null");
		const existing = parsed && typeof parsed === "object" ? Object.entries(parsed as Record<string, unknown>) : [];
		const next: CachedContextUsage = {
			sessionId: data.sessionId, status: "ready", source: data.source,
			tokens: data.tokens, contextWindow: data.contextWindow, percent: data.percent, updatedAt: Date.now(),
		};
		const entries = [...existing.filter(([key]) => key !== cacheKey), [cacheKey, next] as const]
			.sort(([, left], [, right]) => Number((right as Partial<CachedContextUsage>).updatedAt ?? 0) - Number((left as Partial<CachedContextUsage>).updatedAt ?? 0))
			.slice(0, MAX_CACHE_ENTRIES);
		window.localStorage.setItem(CONTEXT_USAGE_CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
	} catch {
		// Local persistence is best-effort; it must never block live usage updates.
	}
}

export function useContextUsage(sessionId: string, streaming: boolean, revision: string, modelKey?: string, activating = false) {
	const cacheKey = cacheKeyFor(sessionId, modelKey);
	const [state, setState] = useState<{ data: SessionContextUsage | null; loading: boolean; failed: boolean; detailsLoaded: boolean }>(() => {
		const cached = readCachedSummary(cacheKey, sessionId);
		return { data: cached, loading: true, failed: false, detailsLoaded: false };
	});
	const refreshRef = useRef<() => Promise<SessionContextUsage | null>>(() => Promise.resolve(null));
	useEffect(() => {
		// The endpoint only reports ready data for the active runtime. During a
		// session switch, wait until SessionsStore has finished activating the
		// target so the old runtime cannot overwrite the new session's summary
		// with a transient inactive response.
		if (activating) {
			refreshRef.current = () => Promise.resolve(null);
			return;
		}
		let disposed = false;
		let inFlight: Promise<SessionContextUsage | null> | null = null;
		let controller: AbortController | undefined;
		let retryTimer: number | undefined;
		let inactiveRetries = 0;
		const scheduleInactiveRetry = () => {
			if (disposed || retryTimer !== undefined || inactiveRetries >= MAX_INACTIVE_RETRIES) return;
			inactiveRetries += 1;
			retryTimer = window.setTimeout(() => {
				retryTimer = undefined;
				void refresh();
			}, INACTIVE_RETRY_DELAY_MS);
		};
		const refresh = () => {
			if (document.hidden || disposed) return Promise.resolve(null);
			if (inFlight) return inFlight;
			const request = (async () => {
				controller = new AbortController();
				const timeout = window.setTimeout(() => controller?.abort(), 10_000);
				try {
					const data = await fetchSessionContextUsage(sessionId, controller.signal);
					if (data.sessionId !== sessionId) throw new Error("Context session mismatch");
					if (!disposed) {
						setState((previous) => data.status === "inactive" && previous.data?.status === "ready"
							// A switch briefly reports the old runtime as inactive. Keep the
							// last summary visible until the target runtime is ready, rather
							// than flashing the control back to an unknown state.
							? { ...previous, loading: false, failed: false, detailsLoaded: false }
							: { data, loading: false, failed: false, detailsLoaded: data.status === "ready" });
						writeCachedSummary(cacheKey, data);
						if (data.status === "inactive") scheduleInactiveRetry();
						else inactiveRetries = 0;
					}
					return data;
				} catch {
					if (!disposed) setState((previous) => ({ ...previous, loading: false, failed: true, detailsLoaded: false }));
					return null;
				} finally {
					window.clearTimeout(timeout);
					inFlight = null;
				}
			})();
			inFlight = request;
			return request;
		};
		refreshRef.current = refresh;
		void refresh();
		const interval = window.setInterval(() => { void refresh(); }, streaming ? 3_000 : 15_000);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			disposed = true;
			controller?.abort();
			if (retryTimer !== undefined) window.clearTimeout(retryTimer);
			window.clearInterval(interval);
			document.removeEventListener("visibilitychange", refresh);
			if (refreshRef.current === refresh) refreshRef.current = () => Promise.resolve(null);
		};
	}, [activating, cacheKey, sessionId, streaming, revision]);
	return { ...state, refresh: () => refreshRef.current() };
}
