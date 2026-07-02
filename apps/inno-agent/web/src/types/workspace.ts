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

export type WorkspaceFileKind = "markdown" | "html" | "pdf" | "image" | "office" | "text" | "binary";

/** Specific office format, used to pick the right client-side renderer. */
export type WorkspaceOfficeFormat = "docx" | "xlsx" | "pptx";

export interface WorkspaceFileDetail {
	path: string;
	name: string;
	kind: WorkspaceFileKind;
	/** For office docs: which format, so the frontend picks the right renderer. */
	format?: WorkspaceOfficeFormat;
	mimeType: string;
	size: number;
	updatedAt: string;
	content?: string;
	url?: string;
	/** For pptx: URL returning per-slide SVG JSON. */
	previewUrl?: string;
}

/** One slide of a pptx rendered to SVG. */
export interface PptxSlide {
	index: number;
	svg: string;
}

/** Response shape of GET /api/workspace/pptx-preview. */
export interface PptxPreviewResult {
	name: string;
	slideCount: number;
	slides: PptxSlide[];
	canvasPx?: [number, number];
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
