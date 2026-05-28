export interface WorkspaceTreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	size?: number;
	updatedAt?: string;
	children?: WorkspaceTreeNode[];
}

export interface WorkspaceTree extends WorkspaceTreeNode {
	root: string;
	type: "directory";
	children: WorkspaceTreeNode[];
}

export type WorkspaceFileKind = "markdown" | "html" | "pdf" | "image" | "text" | "binary";

export interface WorkspaceFileDetail {
	path: string;
	name: string;
	kind: WorkspaceFileKind;
	mimeType: string;
	size: number;
	updatedAt: string;
	content?: string;
	url?: string;
}

/** Node shape expected by react-arborist */
export interface ArboristNode {
	id: string;
	name: string;
	isLeaf: boolean;
	path: string;
	size?: number;
	updatedAt?: string;
	children?: ArboristNode[];
}

export function toArboristNodes(nodes: WorkspaceTreeNode[]): ArboristNode[] {
	return nodes.map((node) => ({
		id: node.path || node.name,
		name: node.name,
		isLeaf: node.type === "file",
		path: node.path,
		size: node.size,
		updatedAt: node.updatedAt,
		children: node.children ? toArboristNodes(node.children) : undefined,
	}));
}
