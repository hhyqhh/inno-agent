import type { InnoContentHubConfig } from "../config.js";
import { GitHubContentSource } from "./github-source.js";
import { BundleServiceSource } from "./bundle-source.js";
import type { RemoteContentSource } from "./types.js";

export * from "./types.js";
export { GitHubContentSource } from "./github-source.js";
export { BundleServiceSource } from "./bundle-source.js";

/**
 * Build the content source for the configured hub. Returns a GitHub-backed
 * source by default; a "bundle" type yields the self-hosted service client.
 *
 * The returned instance owns its own short-lived cache, so the server should
 * create it once and reuse it (recreating it on config change to pick up new
 * owner/repo/token), then call `invalidate()` when settings are saved.
 */
export function createContentSource(hub: InnoContentHubConfig): RemoteContentSource {
	if (hub.type === "bundle") {
		return new BundleServiceSource(hub);
	}
	return new GitHubContentSource(hub);
}
