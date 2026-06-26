import { Play } from "lucide-react";
import { useCallback } from "react";
import { terminalStore } from "../../stores/terminal-store.js";

function defaultCommand(relPath: string): string | null {
	const lower = relPath.toLowerCase();
	const quoted = /[\s'"]/.test(relPath) ? `"${relPath.replace(/"/g, '\\"')}"` : relPath;
	if (lower.endsWith(".py")) return `python ${quoted}`;
	if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return `node ${quoted}`;
	if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return `npx tsx ${quoted}`;
	if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return `bash ${quoted}`;
	return null;
}

interface RunButtonProps {
	filePath: string;
	className?: string;
}

export function RunButton({ filePath, className }: RunButtonProps) {
	const command = defaultCommand(filePath);
	const handleClick = useCallback(() => {
		if (!command) return;
		terminalStore.setOpen(true);
		terminalStore.runCommand(command, filePath);
	}, [command, filePath]);

	if (!command) return null;

	return (
		<button
			onClick={handleClick}
			className={
				className ??
				"flex h-6 items-center gap-1 rounded border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 text-xs font-medium text-[var(--inno-text)] transition-colors hover:bg-[var(--inno-accent-soft)] hover:text-[var(--inno-accent)] disabled:opacity-40"
			}
			title={`Run: ${command}`}
		>
			Run
		</button>
	);
}
