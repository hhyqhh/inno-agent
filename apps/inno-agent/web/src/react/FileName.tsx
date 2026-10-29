import type { HTMLAttributes } from "react";
import { Tooltip } from "./ui/index.js";

interface FileNameProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
	name: string;
}

function splitFileName(name: string): { stem: string; extension: string } {
	const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
	const base = slash >= 0 ? name.slice(slash + 1) : name;
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return { stem: base, extension: "" };
	return { stem: base.slice(0, dot), extension: base.slice(dot) };
}

/** Truncates only the filename stem so its extension always remains visible. */
export function FileName({ name, className, title, ...props }: FileNameProps) {
	const { stem, extension } = splitFileName(name);
	const fileName = (
		<span {...props} className={`inno-file-name${className ? ` ${className}` : ""}`}>
			<span className="inno-file-name-stem">{stem}</span>
			{extension ? <span className="inno-file-name-extension">{extension}</span> : null}
		</span>
	);
	return title ? <Tooltip label={title}>{fileName}</Tooltip> : fileName;
}
