export interface FileApplication {
	id: string;
	name: string;
	isDefault: boolean;
	icon?: string;
}
export interface FileApplications {
	applications: FileApplication[];
	fileManager: "finder" | "explorer" | "files";
	unavailable?: boolean;
}
