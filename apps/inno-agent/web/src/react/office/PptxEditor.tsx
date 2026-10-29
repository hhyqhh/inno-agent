/**
 * PptxEditor — WYSIWYG pptx editing via an embedded, prebuilt PPTist bundle
 * (AGPL-3.0; staged under web/public/pptist by scripts/prepare-pptist.sh).
 * The iframe talks a small postMessage protocol (see PPTist src/embed.ts):
 * after the `pptist:ready` handshake the host sends the pptx bytes, and the
 * file bar's Save action asks PPTist to export the deck back to bytes for
 * the binary write route.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { saveWorkspaceFileBinary } from "../../api/workspace.js";
import type { OfficeEditorHandle, OfficeEditorProps } from "./office-editor-handle.js";

const PPTIST_URL = `/pptist/index.html?embed=1&parentOrigin=${encodeURIComponent(window.location.origin)}`;

const PptxEditor = forwardRef<OfficeEditorHandle, OfficeEditorProps>(function PptxEditor({ file, onReadyChange, onInteract }, ref) {
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [ready, setReady] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const exportedResolver = useRef<((buf: ArrayBuffer) => void) | null>(null);
	// Double-fire guard: a duplicated click event would otherwise run two
	// concurrent exports and the second resolver assignment orphans the first
	// pending promise until its 60 s timeout.
	const savingRef = useRef(false);

	const post = useCallback((message: Record<string, unknown>, transfer?: Transferable[]) => {
		const win = iframeRef.current?.contentWindow;
		if (!win) return;
		win.postMessage(message, window.location.origin, transfer ?? []);
	}, []);

	// Events inside the iframe never reach the host document; the patched
	// bridge's `pptist:change` message below is the real edit signal, so no
	// host-side focus/blur heuristics are needed.

	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (e.origin !== window.location.origin) return;
			if (e.source !== iframeRef.current?.contentWindow) return;
			const data = e.data as { type?: string; buffer?: ArrayBuffer } | null;
			if (!data?.type) return;
			if (data.type === "pptist:ready") setReady(true);
			if (data.type === "pptist:loaded") {
				setLoaded(true);
				onReadyChange?.(true);
			}
			// The patched embed bridge deep-watches the slides store and reports
			// real deck mutations (editor edits, not paging) after the import
			// settle window — the authoritative dirty signal for the file bar.
			if (data.type === "pptist:change") onInteract?.();
			if (data.type === "pptist:exported" && data.buffer) {
				exportedResolver.current?.(data.buffer);
				exportedResolver.current = null;
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [onReadyChange]);

	// Bytes may only be posted after the bridge signals `pptist:ready`; the
	// iframe load event fires well before the Vue app mounts its listener.
	useEffect(() => {
		if (!ready) return;
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(file.url ?? "");
				if (!res.ok) throw new Error(`Failed to load presentation (${res.status})`);
				const buffer = await res.arrayBuffer();
				if (cancelled) return;
				post({ type: "pptist:load", buffer, name: file.name }, [buffer]);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => { cancelled = true; };
	}, [ready, file.url, file.name, post]);

	useImperativeHandle(ref, () => {
		return {
			save: async () => {
				if (!loaded || savingRef.current) return false;
				savingRef.current = true;
				try {
					const buffer = await new Promise<ArrayBuffer>((resolvePromise, reject) => {
						exportedResolver.current = resolvePromise;
						post({ type: "pptist:export" });
						setTimeout(() => reject(new Error("Export timed out")), 60_000);
					});
					const query = file.url?.split("?")[1] ?? "";
					const wsId = new URLSearchParams(query).get("workspaceId") ?? undefined;
					await saveWorkspaceFileBinary(file.path, buffer, wsId);
					return true;
				} catch (err) {
					setError(err instanceof Error ? err.message : "Save failed");
					return false;
				} finally {
					savingRef.current = false;
				}
			},
		};
	}, [loaded, file.path, file.url, file.name, post]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			{error ? <div className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
			<iframe ref={iframeRef} src={PPTIST_URL} title={file.name} className="min-h-0 flex-1 border-0" />
		</div>
	);
});

export default PptxEditor;
