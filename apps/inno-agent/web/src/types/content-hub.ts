export interface ContentCatalogStatus {
	hasUpdate: boolean;
	cachedRevision: string | null;
	remoteRevision: string | null;
	checkedAt: string | null;
}

export interface ContentHubStatus {
	skills: ContentCatalogStatus;
}
