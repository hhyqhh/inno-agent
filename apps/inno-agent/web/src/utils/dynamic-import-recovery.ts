const RECOVERY_SESSION_KEY = "inno-web:dynamic-import-recovery";
const RECOVERY_COOLDOWN_MS = 15_000;

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
	/Failed to fetch dynamically imported module/i,
	/Importing a module script failed/i,
	/ChunkLoadError/i,
	/Loading chunk .* failed/i,
	/Unable to preload CSS/i,
];

function errorMessage(error: unknown): string {
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		return typeof message === "string" ? message : "";
	}
	return "";
}

export function isDynamicImportError(error: unknown): boolean {
	const message = errorMessage(error);
	return DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * A Vite build can replace a hashed lazy chunk while an existing page is
 * still open. Reload once so the page gets the current index and chunk graph;
 * a cooldown prevents an unavailable asset from creating an infinite reload.
 */
export function recoverFromDynamicImportError(error: unknown): boolean {
	if (!isDynamicImportError(error) || typeof window === "undefined") return false;

	try {
		const previousAttempt = Number(window.sessionStorage.getItem(RECOVERY_SESSION_KEY));
		if (Number.isFinite(previousAttempt) && Date.now() - previousAttempt < RECOVERY_COOLDOWN_MS) {
			return false;
		}
		window.sessionStorage.setItem(RECOVERY_SESSION_KEY, String(Date.now()));
	} catch {
		// If sessionStorage is unavailable, keep the visible error recovery path
		// instead of risking an unbounded reload loop.
		return false;
	}

	window.location.reload();
	return true;
}
