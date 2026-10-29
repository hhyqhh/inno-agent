import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuActionItem, DropdownMenuContent, DropdownMenuTrigger } from "./Menu.js";

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

/** Fixed-coordinate context actions using the shared menu behavior and styling. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
	return (
		<DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-hidden="true"
					tabIndex={-1}
					className="inno-context-menu-anchor"
					style={{ left: x, top: y }}
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				side="bottom"
				sideOffset={0}
				collisionPadding={8}
				className="inno-smart-menu"
				onCloseAutoFocus={(event) => event.preventDefault()}
			>
				{items.map((item, index) => (
					<DropdownMenuActionItem
						key={index}
						label={item.label}
						variant={item.danger ? "danger" : "default"}
						className="inno-smart-menu-item"
						onSelect={item.onSelect}
					/>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
