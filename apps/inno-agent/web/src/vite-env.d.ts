/// <reference types="vite/client" />

interface ImportMeta {
	readonly glob: (pattern: string, options?: Record<string, unknown>) => Record<string, unknown>;
}
