/** PPTist bridge with correlated exports and deterministic teardown. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { preservePptx, type PptxSnapshot } from "./office-ooxml.js";
import type { OfficeEditorHandle, OfficeEditorProps } from "./office-editor-handle.js";

interface PendingExport {
    id: number;
    resolve(snapshot: PptxSnapshot): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}
const PptxEditor = forwardRef<OfficeEditorHandle, OfficeEditorProps>(function PptxEditor({ file, onReadyChange, onInteract }, ref) {
    const iframe = useRef<HTMLIFrameElement>(null);
    const source = useRef<{ bytes: Uint8Array; baseline?: PptxSnapshot } | null>(null);
    const pending = useRef<PendingExport | null>(null);
    const nextId = useRef(0);
    const callbacks = useRef({ onReadyChange, onInteract });
    callbacks.current = { onReadyChange, onInteract };
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState("");
    const origin = window.location.origin;
    const url = `/pptist/index.html?embed=1&parentOrigin=${encodeURIComponent(origin)}`;

    useEffect(() => {
        let cancelled = false;
        let importStarted = false;
        const abort = new AbortController();
        const loadTimer = setTimeout(() => setError("Presentation loading timed out"), 90_000);
        setLoaded(false);
        callbacks.current.onReadyChange?.(false);
        const onMessage = async (event: MessageEvent) => {
            if (event.origin !== origin || event.source !== iframe.current?.contentWindow) return;
            const data = event.data;
            if (!data || typeof data !== "object") return;
            if (data.type === "pptist:ready" && !importStarted) {
                importStarted = true;
                try {
                    const response = await fetch(file.url ?? "", { signal: abort.signal });
                    if (!response.ok) throw new Error(`Failed to load presentation (${response.status})`);
                    const buffer = await response.arrayBuffer();
                    if (!cancelled) source.current = { bytes: new Uint8Array(buffer.slice(0)) };
                    if (!cancelled) iframe.current?.contentWindow?.postMessage({ type: "pptist:load", buffer, name: file.name }, origin, [buffer]);
                } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); }
            }
            if (data.type === "pptist:loaded" && source.current && data.snapshot?.slides instanceof Array) {
                source.current.baseline = data.snapshot;
                clearTimeout(loadTimer);
                setLoaded(true);
                callbacks.current.onReadyChange?.(true);
            }
            if (data.type === "pptist:change") callbacks.current.onInteract?.();
            if (data.type === "pptist:error") {
                setError(String(data.error ?? "PPTist failed"));
                const call = pending.current;
                if (call && call.id === data.requestId) { clearTimeout(call.timer); pending.current = null; call.reject(new Error(String(data.error))); }
            }
            const call = pending.current;
            if (data.type === "pptist:exported" && call && data.requestId === call.id && data.snapshot?.slides instanceof Array) {
                clearTimeout(call.timer);
                pending.current = null;
                call.resolve(data.snapshot);
            }
        };
        window.addEventListener("message", onMessage);
        return () => {
            cancelled = true;
            abort.abort();
            source.current = null;
            clearTimeout(loadTimer);
            window.removeEventListener("message", onMessage);
            if (pending.current) { clearTimeout(pending.current.timer); pending.current.reject(new Error("Editor closed")); pending.current = null; }
        };
    }, [file.url, file.name, origin]);

    useImperativeHandle(ref, () => ({
        exportBytes: async () => {
            if (!loaded || pending.current) throw new Error("Editor is not ready");
            // A request id prevents an export that arrived after its timeout
            // from satisfying a later save with the wrong document bytes.
            const snapshot = await new Promise<PptxSnapshot>((resolve, reject) => {
                const id = ++nextId.current;
                const timer = setTimeout(() => {
                    if (pending.current?.id !== id) return;
                    pending.current = null;
                    reject(new Error("Export timed out"));
                }, 60_000);
                pending.current = { id, timer, resolve, reject };
                iframe.current?.contentWindow?.postMessage({ type: "pptist:export", requestId: id }, origin);
            });
            if (!source.current?.baseline) throw new Error("No original presentation snapshot");
            return preservePptx(source.current.bytes, source.current.baseline, snapshot);
        },
    }), [loaded, origin, file.path, file.url]);

    return <div className="flex h-full min-h-0 flex-col">
        {error ? <div role="alert" className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
        <iframe ref={iframe} src={url} title={file.name} className="min-h-0 flex-1 border-0" />
    </div>;
});
export default PptxEditor;
