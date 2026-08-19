import "./app.css";
import "./i18n/index.js";
import "./stores/theme-store.js";
// Register <markdown-block> explicitly — QuestionDialog depends on it and must not
// rely on pi-web-ui's side-effect import chain (ChatCenter → MarkdownArtifact → mini-lit).
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";

import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./react/App.js";
import { recoverFromDynamicImportError } from "./utils/dynamic-import-recovery.js";

interface AppErrorBoundaryState {
	error: Error | null;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
	state: AppErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		if (recoverFromDynamicImportError(error)) return;
		console.error("[inno-web] uncaught render error", error, info.componentStack);
	}

	render() {
		if (!this.state.error) return this.props.children;
		return (
			<main className="flex h-full items-center justify-center bg-[var(--inno-chat-bg)] p-6 text-[var(--inno-text)]">
				<div className="w-full max-w-lg rounded-lg border border-[var(--inno-danger-border)] bg-[var(--inno-surface)] p-5 shadow-sm">
					<h1 className="text-base font-semibold">页面内容加载失败</h1>
					<p className="mt-2 text-sm text-[var(--inno-text-muted)]">
						会话数据仍然安全保存。请刷新页面重试；如果问题持续出现，请检查浏览器控制台中的模块加载错误。
					</p>
					<pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--inno-surface-muted)] p-2 text-xs text-[var(--inno-danger)]">
						{this.state.error.message}
					</pre>
					<button
						type="button"
						className="inno-primary-button mt-4 rounded-md px-3 py-1.5 text-sm text-white"
						onClick={() => window.location.reload()}
					>
						刷新页面
					</button>
				</div>
			</main>
		);
	}
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
	<StrictMode>
		<AppErrorBoundary>
			<App />
		</AppErrorBoundary>
	</StrictMode>,
);

console.log("[inno-web] React initialized");
