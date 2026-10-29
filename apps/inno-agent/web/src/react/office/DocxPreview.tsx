import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import type { WorkspaceFileDetail } from "../../types/workspace.js";
import { Button, Spinner } from "../ui/index.js";
import PdfPreview from "./PdfPreview.js";

/** Fixed-page PDF keeps Word's paper geometry when the preview panel is resized. */
export default function DocxPreview({ file }: { file: WorkspaceFileDetail }) {
	const { t } = useTranslation();
	const [attempt, setAttempt] = useState(0);
	const key = JSON.stringify([file.previewUrl, file.path, file.updatedAt, file.size, attempt]);
	const [result, setResult] = useState({ key: "", url: "", errorCode: "" });

	useEffect(() => {
		const controller = new AbortController();

		(async () => {
			try {
				if (!file.previewUrl) throw new Error("WORD_PREVIEW_FAILED");
				const response = await fetch(`${file.previewUrl}&metadata=1`, { signal: controller.signal, cache: "no-store" });
				if (!response.ok) {
					const body = await response.json().catch(() => ({})) as { code?: string };
					throw new Error(body.code ?? "WORD_PREVIEW_FAILED");
				}
				const preview = await response.json() as { url?: string };
				if (!preview.url?.startsWith("/api/workspace/word-preview?")) throw new Error("WORD_PREVIEW_FAILED");
				if (controller.signal.aborted) return;
				// Let the browser stream/range-load the PDF instead of waiting for a full Blob copy.
				setResult({ key, url: preview.url, errorCode: "" });
			} catch (error) {
				if (!controller.signal.aborted) setResult({ key, url: "", errorCode: error instanceof Error ? error.message : "WORD_PREVIEW_FAILED" });
			}
		})();
		return () => {
			controller.abort();
		};
	}, [key, file.previewUrl]);

	if (result.key !== key) {
		return <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-[var(--inno-text-muted)]">
			<Spinner size={16} />{t("preview.wordOpening")}
		</div>;
	}
	if (result.errorCode) {
		const messageKey = result.errorCode === "WORD_ENGINE_UNAVAILABLE" ? "preview.wordEngineMissing"
			: result.errorCode === "WORD_ENGINE_INCOMPATIBLE" ? "preview.wordEngineIncompatible"
			: result.errorCode === "WORD_PREVIEW_BUSY" ? "preview.wordBusy"
			: result.errorCode === "WORD_PREVIEW_TOO_LARGE" ? "preview.wordTooLarge" : "preview.docxFailed";
		return <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[var(--inno-text-muted)]">
			<div className="font-medium text-[var(--inno-text)]">{file.name}</div>
			<div>{t(messageKey)}</div>
			<div className="flex flex-wrap justify-center gap-2">
				<Button size="xs" onClick={() => setAttempt((value) => value + 1)}><RotateCcw size={14} />{t("preview.wordRetry")}</Button>
			</div>
		</div>;
	}
	// The native browser PDF toolbar cannot inherit our theme or remove actions.
	return <PdfPreview key={key} url={result.url} name={file.name} />;
}
