import { EventEmitter } from "./event-emitter.js";

export type ShortcutKey = `workspace:${string}` | `reminder:${string}` | "reminders";
export interface ShortcutCard {
	key: ShortcutKey;
	size: "standard" | "wide";
}

const storageKey = "inno.homeShortcuts.v1";

function readCards(): ShortcutCard[] {
	try {
		const data: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
		if (!Array.isArray(data)) return [];
		const keys = new Set<string>();
		return data.filter((item): item is ShortcutCard => {
			if (typeof item?.key !== "string" || !/^(reminders|(?:workspace|reminder):.+)$/.test(item.key)
				|| (item.size !== "standard" && item.size !== "wide") || keys.has(item.key)) return false;
			keys.add(item.key);
			return true;
		});
	} catch {
		return [];
	}
}

class HomeShortcutsStore extends EventEmitter<{ change: void }> {
	cards = readCards();

	constructor() {
		super();
		if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
			if (event.key === storageKey || event.key === null) {
				this.cards = readCards();
				this.emit("change", undefined);
			}
		});
	}

	add(key: ShortcutKey) {
		if (!this.cards.some((card) => card.key === key)) {
			this.update([...this.cards, { key, size: key === "reminders" ? "wide" : "standard" }]);
		}
	}

	update(cards: ShortcutCard[]) {
		this.cards = cards;
		try { window.localStorage.setItem(storageKey, JSON.stringify(cards)); } catch { /* The board still works in memory. */ }
		this.emit("change", undefined);
	}
}

export const homeShortcutsStore = new HomeShortcutsStore();
