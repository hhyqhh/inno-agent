import { html, LitElement, nothing } from "lit";
import { customElement, state, query } from "lit/decorators.js";
import { chatStore } from "../../stores/chat-store.js";
import type { ChatMessage } from "../../types/chat.js";
import { uploadRawFile, type RawUploadResult } from "../../api/uploads.js";
import { normalizeMarkdownMath } from "../../utils/markdown-math.js";

// Import Pi SDK markdown renderer
import "@earendil-works/pi-web-ui";

@customElement("inno-chat-center")
export class ChatCenter extends LitElement {
	@state() private _messages: ChatMessage[] = [];
	@state() private _isSending = false;
	@state() private _streamingText = "";
	@state() private _streamingThinking = "";
	@state() private _activeTools: { toolCallId: string; toolName: string; args: unknown }[] = [];
	@state() private _uploads: RawUploadResult[] = [];
	@state() private _isUploading = false;
	@query("#chat-input") private _inputEl!: HTMLTextAreaElement;
	@query("#file-input") private _fileInputEl!: HTMLInputElement;
	@query("#message-container") private _scrollContainer!: HTMLElement;
	private _unsub?: () => void;

	protected override createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		this._unsub = chatStore.on("change", () => {
			this._messages = chatStore.messages;
			this._isSending = chatStore.isSending;
			this._streamingText = chatStore.streamingText;
			this._streamingThinking = chatStore.streamingThinking;
			this._activeTools = chatStore.activeTools;
			requestAnimationFrame(() => this._scrollToBottom());
		});
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this._unsub?.();
	}

	private _scrollToBottom() {
		if (this._scrollContainer) {
			this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
		}
	}

	private async _handleSend() {
		const input = this._inputEl?.value?.trim();
		if ((!input && this._uploads.length === 0) || this._isSending || this._isUploading) return;
		this._inputEl.value = "";
		this._inputEl.style.height = "auto";
		const uploadNote = this._uploads.length > 0
			? `\n\n[已上传到 L2 raw 原始数据]\n${this._uploads.map((file) => `- ${file.fileName}: ${file.rawPath}`).join("\n")}`
			: "";
		this._uploads = [];
		await chatStore.send(`${input}${uploadNote}`);
	}

	private _handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this._handleSend();
		}
	}

	private _handleInput() {
		const el = this._inputEl;
		if (el) {
			el.style.height = "auto";
			el.style.height = Math.min(el.scrollHeight, 200) + "px";
		}
	}

	private async _handleFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		if (files.length === 0) return;
		this._isUploading = true;
		try {
			const uploaded = await Promise.all(files.map((file) => uploadRawFile(file)));
			this._uploads = [...this._uploads, ...uploaded];
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown upload error";
			this._uploads = [
				...this._uploads,
				{ fileName: "Upload failed", mimeType: "text/plain", size: 0, rawPath: message },
			];
		} finally {
			this._isUploading = false;
			input.value = "";
		}
	}

	private _removeUpload(index: number) {
		this._uploads = this._uploads.filter((_, i) => i !== index);
	}

	private _renderMessage(msg: ChatMessage) {
		if (msg.role === "user") {
			return html`
				<div class="flex justify-end">
					<div
						class="w-fit rounded-lg border border-[var(--inno-border)] bg-slate-100/80 px-3 py-2 text-[13px] leading-normal text-[var(--inno-text)] whitespace-pre-wrap break-words"
						style="max-width: min(68%, 36rem);"
					>${msg.content.trim()}</div>
				</div>
			`;
		}
		return html`
			<div class="flex justify-start">
				<div class="max-w-[76%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-[13px] leading-relaxed text-[var(--inno-text)]">
					<markdown-artifact .content=${normalizeMarkdownMath(msg.content)}></markdown-artifact>
				</div>
			</div>
		`;
	}

	private _renderStreamingIndicator() {
		if (!this._isSending) return nothing;

		return html`
			<!-- Active tool calls -->
			${this._activeTools.length > 0
				? html`
						<div class="flex justify-start">
							<div class="max-w-[76%] rounded-lg border border-blue-100 bg-blue-50/80 px-3 py-2 text-[13px]">
								${this._activeTools.map(
									(t) => html`
										<div class="flex items-center gap-2 text-muted-foreground">
											<span class="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></span>
											<span class="font-mono text-xs">${t.toolName}</span>
										</div>
									`,
								)}
							</div>
						</div>
					`
				: nothing}

			<!-- Streaming thinking -->
			${this._streamingThinking
				? html`
						<div class="flex justify-start">
							<details class="max-w-[76%] rounded-lg border border-[var(--inno-border)] bg-white/90 px-3 py-2 text-xs text-[var(--inno-text-muted)]">
								<summary class="cursor-pointer">Thinking...</summary>
								<pre class="whitespace-pre-wrap mt-1 font-mono">${this._streamingThinking}</pre>
							</details>
						</div>
					`
				: nothing}

			<!-- Streaming text -->
			${this._streamingText
				? html`
						<div class="flex justify-start">
							<div class="max-w-[76%] rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2 text-[13px] leading-relaxed text-[var(--inno-text)]">
								<markdown-artifact .content=${normalizeMarkdownMath(this._streamingText)}></markdown-artifact>
							</div>
						</div>
					`
				: nothing}

			<!-- Typing indicator (when no text yet) -->
			${!this._streamingText && this._activeTools.length === 0
				? html`
						<div class="flex justify-start">
							<div class="max-w-[76%] rounded-lg bg-[var(--inno-surface-muted)] px-3 py-2 text-sm text-[var(--inno-text-muted)]">
								<span class="inline-flex gap-1">
									<span class="animate-bounce" style="animation-delay: 0ms">\u00B7</span>
									<span class="animate-bounce" style="animation-delay: 150ms">\u00B7</span>
									<span class="animate-bounce" style="animation-delay: 300ms">\u00B7</span>
								</span>
							</div>
						</div>
					`
				: nothing}
		`;
	}

	override render() {
		return html`
			<!-- Messages -->
			<div
				id="message-container"
				class="flex-1 min-h-0 overflow-y-auto px-4 py-3"
				style="background:
					linear-gradient(90deg, rgba(229, 231, 235, 0.36) 1px, transparent 1px),
					linear-gradient(rgba(229, 231, 235, 0.36) 1px, transparent 1px),
					var(--inno-chat-bg);
					background-size: 32px 32px;"
			>
				<div class="max-w-3xl mx-auto flex flex-col gap-2.5">
					${this._messages.length === 0 && !this._isSending
						? html`
								<div class="flex flex-col items-center justify-center h-full text-[var(--inno-text-muted)] pt-20">
									<div class="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] text-sm font-semibold text-[var(--inno-accent)] shadow-sm">IA</div>
									<h2 class="text-lg font-medium mb-1 text-[var(--inno-text)]">Inno Agent</h2>
									<p class="text-sm">Ask me anything to get started</p>
								</div>
							`
						: nothing}
					${this._messages.map((msg) => this._renderMessage(msg))}
					${this._renderStreamingIndicator()}
				</div>
			</div>

			<!-- Input -->
			<div class="shrink-0 border-t border-[var(--inno-border)] bg-white/95 p-3">
				<div class="max-w-3xl mx-auto">
					${this._uploads.length > 0
						? html`
								<div class="mb-2 flex flex-wrap gap-1.5">
									${this._uploads.map((file, index) => html`
										<span class="inline-flex items-center gap-1 rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] px-2 py-1 text-xs">
											<span class="max-w-[220px] truncate">${file.fileName}</span>
											<span class="text-muted-foreground">${file.rawPath}</span>
											<button
												class="text-muted-foreground hover:text-foreground"
												title="Remove upload"
												@click=${() => this._removeUpload(index)}
											>
												x
											</button>
										</span>
									`)}
								</div>
							`
						: nothing}
					<div class="flex gap-2 items-end">
					<input
						id="file-input"
						type="file"
						class="hidden"
						multiple
						@change=${this._handleFiles}
					/>
					<button
						class="h-10 w-10 shrink-0 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] text-sm text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)] disabled:opacity-50"
						title="Upload files to L2 raw"
						?disabled=${this._isSending || this._isUploading}
						@click=${() => this._fileInputEl?.click()}
					>
						${this._isUploading ? "..." : "+"}
					</button>
					<textarea
						id="chat-input"
						class="flex-1 resize-none rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2.5 text-sm shadow-sm
							focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300 min-h-[40px] max-h-[140px]"
						placeholder="Type a message..."
						rows="1"
						@keydown=${this._handleKeydown}
						@input=${this._handleInput}
						?disabled=${this._isSending || this._isUploading}
					></textarea>
					<button
						class="h-10 rounded-lg px-3 text-sm font-medium transition-colors
							${this._isSending || this._isUploading
								? "bg-[var(--inno-surface-muted)] text-[var(--inno-text-muted)] cursor-not-allowed"
								: "bg-primary text-primary-foreground hover:bg-primary/90"}"
						?disabled=${this._isSending || this._isUploading}
						@click=${this._handleSend}
					>
						Send
					</button>
					</div>
				</div>
			</div>
		`;
	}
}
