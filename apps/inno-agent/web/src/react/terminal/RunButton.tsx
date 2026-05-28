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
				"flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 transition-colors hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700"
			}
			title={`Run: ${command}`}
		>
			<Play size={12} />
			Run
		</button>
	);
}
