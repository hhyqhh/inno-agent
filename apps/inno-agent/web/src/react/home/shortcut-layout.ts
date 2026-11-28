import type { ShortcutCard } from "../../stores/home-shortcuts-store.js";

export function arrangeShortcuts(cards: ShortcutCard[], columns: number): ShortcutCard[] {
	if (columns < 2) return cards;
	const remaining = [...cards];
	const ordered: ShortcutCard[] = [];
	const width = (card: ShortcutCard) => card.size === "wide" ? 2 : 1;
	let available = columns;
	let standard = cards.filter((card) => width(card) === 1).length;
	while (remaining.length) {
		const wide = remaining.length - standard;
		// Reserve pairs when another standard would cost a full row.
		const pair = columns === 3 && available === 2 && wide > 0 && standard < Math.max(2, wide + 1);
		const index = remaining.findIndex((card) => pair ? width(card) === 2 : width(card) <= available);
		if (index < 0) { available = columns; continue; }
		const [card] = remaining.splice(index, 1);
		ordered.push(card);
		if (width(card) === 1) standard--;
		available = available - width(card) || columns;
	}
	return ordered;
}

export function moveShortcut(cards: ShortcutCard[], from: number, target: number, columns: number): ShortcutCard[] | undefined {
	if (from === target || !cards[from] || !cards[target]) return undefined;
	const card = cards[from];
	const neighbor = cards[target];
	const direction = Math.sign(target - from);
	const rest = cards.filter((item) => item !== card);
	for (let index = target; index >= 0 && index < cards.length; index += direction) {
		const candidate = [...rest];
		candidate.splice(index, 0, card);
		const order = arrangeShortcuts(candidate, columns);
		const destination = order.indexOf(card);
		if ((destination - from) * direction > 0 && (destination - order.indexOf(neighbor)) * direction > 0) return order;
	}
	return undefined;
}
