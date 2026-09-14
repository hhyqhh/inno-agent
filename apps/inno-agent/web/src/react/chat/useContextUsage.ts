import { useEffect, useState } from "react";
import { fetchSessionContextUsage, type SessionContextUsage } from "../../api/sessions.js";

export function useContextUsage(sessionId: string, streaming: boolean, revision: string) {
	const [state, setState] = useState<{ data: SessionContextUsage | null; loading: boolean; failed: boolean }>({ data: null, loading: true, failed: false });
	useEffect(() => {
		let disposed = false;
		let inFlight = false;
		let controller: AbortController | undefined;
		const refresh = async () => {
			if (document.hidden || inFlight) return;
			inFlight = true;
			controller = new AbortController();
			const timeout = window.setTimeout(() => controller?.abort(), 10_000);
			try {
				const data = await fetchSessionContextUsage(sessionId, controller.signal);
				if (data.sessionId !== sessionId) throw new Error("Context session mismatch");
				if (!disposed) setState({ data, loading: false, failed: false });
			} catch {
				if (!disposed) setState({ data: null, loading: false, failed: true });
			} finally {
				window.clearTimeout(timeout);
				inFlight = false;
			}
		};
		void refresh();
		const interval = window.setInterval(() => { void refresh(); }, streaming ? 3_000 : 15_000);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			disposed = true;
			controller?.abort();
			window.clearInterval(interval);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [sessionId, streaming, revision]);
	return state;
}
