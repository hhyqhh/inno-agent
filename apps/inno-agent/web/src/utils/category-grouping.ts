/**
 * Shared helpers for client-side search + category-based grouping used by the
 * Skills panel (local + library) and the Simple Mode preset grid.
 */

/**
 * Substring match (case-insensitive) on any of name / description / category.
 * `categoryLabel` is the localized display label for the category (when
 * different from the raw value), so a search in English mode also matches the
 * translated category — e.g. "document" finds items categorized "文档处理".
 */
export function matchesQuery(
	item: { name: string; description?: string; category?: string },
	query: string,
	categoryLabel?: string,
): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	return (
		item.name.toLowerCase().includes(q) ||
		(item.description?.toLowerCase().includes(q) ?? false) ||
		(item.category?.toLowerCase().includes(q) ?? false) ||
		(categoryLabel?.toLowerCase().includes(q) ?? false)
	);
}

/**
 * Group items by category. Items without a category land under `fallback`
 * (the localized "Uncategorized" label). Returns the entries pre-sorted with
 * the fallback group last so categorized items lead the list.
 */
export function groupByCategory<T extends { category?: string }>(items: T[], fallback: string): [string, T[]][] {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = item.category?.trim() || fallback;
		const list = map.get(key);
		if (list) list.push(item);
		else map.set(key, [item]);
	}
	const entries = Array.from(map.entries());
	entries.sort(([a], [b]) => {
		if (a === fallback) return 1;
		if (b === fallback) return -1;
		return a.localeCompare(b);
	});
	return entries;
}
