export type FileOpenPreference = { kind: "preview" } | { kind: "application"; id: string; name: string };

function preferenceKey(path: string): string {
	const name = path.split(/[\\/]/).pop() ?? "";
	const extension = name.match(/\.[^.]+$/)?.[0].toLowerCase() ?? "";
	return `inno.fileOpenPreference:${extension}`;
}

// Keep one preference per format: an Excel choice must not replace how Word
// opens. Store only a successful choice, not a menu highlight or failed launch.
export function readFileOpenPreference(path: string): FileOpenPreference | null {
	try {
		const value = JSON.parse(localStorage.getItem(preferenceKey(path)) ?? "null");
		if (value?.kind === "preview") return { kind: "preview" };
		if (value?.kind === "application" && typeof value.id === "string" && value.id && typeof value.name === "string") {
			return { kind: "application", id: value.id, name: value.name };
		}
	} catch { /* Unavailable storage or an old preference must not block opening. */ }
	return null;
}

export function rememberFileOpenPreference(path: string, preference: FileOpenPreference): void {
	try { localStorage.setItem(preferenceKey(path), JSON.stringify(preference)); }
	catch { /* Opening remains usable when local preferences cannot be saved. */ }
}
