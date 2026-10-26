/** PPTist's same-origin bridge exports bytes; the session owns copy creation. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { OfficeEditorHandle, OfficeEditorProps } from "./office-editor-handle.js";

interface PendingExport {
    id: number;
    resolve(buffer: Uint8Array): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}
const PptxEditor = forwardRef<OfficeEditorHandle, OfficeEditorProps>(function PptxEditor({ file, onReadyChange, onInteract }, ref) {
    const iframe = useRef<HTMLIFrameElement>(null);
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
                    if (!cancelled) iframe.current?.contentWindow?.postMessage({ type: "pptist:load", buffer, name: file.name }, origin, [buffer]);
                } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); }
            }
            if (data.type === "pptist:loaded") {
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
            if (data.type === "pptist:exported" && call && data.requestId === call.id && data.buffer instanceof ArrayBuffer) {
                clearTimeout(call.timer);
                pending.current = null;
                call.resolve(new Uint8Array(data.buffer));
            }
        };
        window.addEventListener("message", onMessage);
        return () => {
            cancelled = true;
            abort.abort();
            clearTimeout(loadTimer);
            window.removeEventListener("message", onMessage);
            if (pending.current) { clearTimeout(pending.current.timer); pending.current.reject(new Error("Editor closed")); pending.current = null; }
        };
    }, [file.url, file.name, origin]);

    useImperativeHandle(ref, () => ({
        exportBytes: async () => {
            if (!loaded || pending.current) throw new Error("Presentation is not ready to export");
            return new Promise<Uint8Array>((resolve, reject) => {
                const id = ++nextId.current;
                const timer = setTimeout(() => {
                    if (pending.current?.id !== id) return;
                    pending.current = null;
                    reject(new Error("Export timed out"));
                }, 60_000);
                pending.current = { id, timer, resolve, reject };
                iframe.current?.contentWindow?.postMessage({ type: "pptist:export", requestId: id }, origin);
            });
        },
    }), [loaded, origin]);

    return <div className="flex h-full min-h-0 flex-col">
        {error ? <div role="alert" className="border-b border-[var(--inno-border)] px-3 py-2 text-xs text-[var(--inno-danger)]">{error}</div> : null}
        <iframe ref={iframe} src={url} title={file.name} className="min-h-0 flex-1 border-0" />
    </div>;
});
export default PptxEditor;
