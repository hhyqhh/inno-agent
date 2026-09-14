import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface ContextMenuItem {
	label: ReactNode;
	onSelect: () => void;
	danger?: boolean;
}

interface ContextMenuProps {
	x: number;
	y: number;
	items: ContextMenuItem[];
	onClose: () => void;
}

/** Margin kept between the menu and the viewport edges. */
const VIEWPORT_MARGIN = 8;

/** Shared fixed-position context menu used by workspace files and attachments. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	// Clamped position; null until the menu has been measured once so it never
	// flashes off-screen when opened near the right/bottom edge (e.g. phones).
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	useLayoutEffect(() => {
		const el = menuRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const left = Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - rect.width - VIEWPORT_MARGIN));
		const top = Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - rect.height - VIEWPORT_MARGIN));
		setPosition({ left, top });
	}, [x, y]);

	return (
		<>
			<div
				className="fixed inset-0 z-40"
				aria-hidden="true"
				onClick={(event) => { event.stopPropagation(); onClose(); }}
				onContextMenu={(event) => event.stopPropagation()}
			/>
			<div
				ref={menuRef}
				className="inno-smart-menu"
				style={{
					left: position?.left ?? x,
					top: position?.top ?? y,
					visibility: position ? "visible" : "hidden",
				}}
				onClick={(event) => event.stopPropagation()}
				onContextMenu={(event) => event.stopPropagation()}
			>
				{items.map((item, index) => (
					<button
						key={index}
						type="button"
						className={`inno-smart-menu-item ${item.danger ? "is-danger" : ""}`}
						onClick={() => {
							item.onSelect();
							onClose();
						}}
					>
						{item.label}
					</button>
				))}
			</div>
		</>
	);
}
