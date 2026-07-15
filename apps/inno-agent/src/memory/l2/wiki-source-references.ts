import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { readText, writeText } from "../../storage/file-store.js";
import { logger } from "../../logger.js";
import { parseFrontmatter, serializeFrontmatter } from "./wiki-maintainer.js";

export function detachSourceFromWikiPage(
	l2DataDir: string,
	wikiPath: string,
	options: {
		sourceId: string;
		rawPath: string;
		sourcePagePath?: string;
	},
): "deleted" | "kept" | "unchanged" {
	const absPath = join(l2DataDir, wikiPath);
	if (!existsSync(absPath)) return "unchanged";
	try {
		const { frontmatter, body } = parseFrontmatter(readText(absPath));
		if (!frontmatter) return "unchanged";

		const nextSourceIds = frontmatter.source_ids.filter((id) => id !== options.sourceId);
		const referencesSource = nextSourceIds.length !== frontmatter.source_ids.length;
		if (referencesSource && nextSourceIds.length === 0) {
			unlinkSync(absPath);
			return "deleted";
		}

		const nextSources = frontmatter.sources.filter(
			(source) => source !== options.rawPath && source !== options.sourcePagePath,
		);
		const nextBody = options.sourcePagePath
			? body
				.split("\n")
				.filter((line) => !(line.trim().startsWith("-") && line.includes(options.sourcePagePath!)))
				.join("\n")
			: body;
		if (!referencesSource && nextSources.length === frontmatter.sources.length && nextBody === body) {
			return "unchanged";
		}

		frontmatter.source_ids = nextSourceIds;
		frontmatter.sources = nextSources;
		frontmatter.updated = new Date().toISOString().slice(0, 10);
		writeText(absPath, `${serializeFrontmatter(frontmatter)}\n${nextBody.replace(/^\n/, "")}`);
		return "kept";
	} catch (err) {
		logger.warn({ err, wikiPath, sourceId: options.sourceId }, "failed to detach source from wiki page");
		return "unchanged";
	}
}
