import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TerminalDrawer } from "../terminal/TerminalDrawer.js";

interface ChatWelcomeProps {
	questionHint: ReactNode;
	busyBlocker: ReactNode;
	smartToast: ReactNode;
	composer: ReactNode;
	wsError: string;
	/** Floating notice rendered over the welcome area. */
	topOverlay?: ReactNode;
}

export function ChatWelcome({
	questionHint,
	busyBlocker,
	smartToast,
	composer,
	wsError,
	topOverlay,
}: ChatWelcomeProps) {
	const { t } = useTranslation();
	return (
		<section className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--inno-chat-bg)]">
			<div className="inno-chat-top-drag-region" aria-hidden="true" />
			{topOverlay}
			{smartToast}
			<div className="relative z-[1] flex min-h-0 flex-1 justify-center overflow-y-auto px-4">
				<div className="inno-chat-welcome-layout w-full max-w-[760px]">
					<div className="inno-chat-welcome-stage">
						<div className="inno-chat-welcome-heading">
							<div className="inno-chat-welcome-brand mb-4 flex h-12 w-12 select-none items-center justify-center rounded-xl border border-[var(--inno-border)] bg-[var(--inno-surface)] text-base font-semibold text-[var(--inno-text)] shadow-sm">IA</div>
							<h1 className="text-[28px] font-normal tracking-wide text-[var(--inno-text)]">{t("welcome.greeting")}</h1>

							{questionHint}
							{busyBlocker}
						</div>

						{composer}

						{wsError ? <p className="inno-chat-welcome-error text-xs text-[var(--inno-danger)]">{wsError}</p> : null}
					</div>
				</div>
			</div>
			<TerminalDrawer />
		</section>
	);
}
