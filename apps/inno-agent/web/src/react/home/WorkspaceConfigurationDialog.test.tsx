import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/index.js";
import { WorkspaceConfigurationDialog } from "./WorkspaceConfigurationDialog.js";

const mocks = vi.hoisted(() => ({
	listSkills: vi.fn(), listSkillLibrary: vi.fn(), generateWorkspaceDraft: vi.fn(),
	importFromLibrary: vi.fn(), createWorkspace: vi.fn(), updateWorkspace: vi.fn(),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, params?: { name?: string; count?: number }) => params?.name ? `${key} ${params.name}` : params?.count !== undefined ? `${key} ${params.count}` : key }),
}));
vi.mock("../../api/skills.js", () => ({ listSkills: mocks.listSkills, listSkillLibrary: mocks.listSkillLibrary }));
vi.mock("../../api/workspaces.js", () => ({ generateWorkspaceDraft: mocks.generateWorkspaceDraft }));
vi.mock("../../stores/skills-store.js", () => ({ skillsStore: { importFromLibrary: mocks.importFromLibrary } }));
vi.mock("../../stores/workspaces-store.js", () => ({ workspacesStore: { create: mocks.createWorkspace, update: mocks.updateWorkspace } }));

const localSkill = { name: "local-lesson", description: "Lesson", enabled: true, loaded: true };
const librarySkill = { name: "Exam2Knowledge", description: "Prepare exam lessons", installed: false };
const localAlternative = { name: "class-exam-review", description: "Review exam questions", installed: true };
const libraryAlternative = { name: "math-tutor", description: "Explain math", installed: false };

beforeAll(() => {
	if (!HTMLDialogElement.prototype.showModal) {
		HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
		HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
	}
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listSkills.mockResolvedValue([localSkill, { ...localAlternative, enabled: true, loaded: true }]);
	mocks.listSkillLibrary.mockResolvedValue([librarySkill, libraryAlternative]);
	mocks.generateWorkspaceDraft.mockResolvedValue({
		name: "Math", purpose: "Prepare classes", skillNames: [localSkill.name], linkedWorkspaceIds: [], librarySkills: [librarySkill],
		alternativeSkills: [localAlternative, libraryAlternative],
	});
	mocks.createWorkspace.mockResolvedValue({ id: "math" });
	mocks.updateWorkspace.mockResolvedValue({ id: "ws-edit", name: "Updated Math" });
});

afterEach(cleanup);

function generate(theme: "light" | "dark") {
	render(<TooltipProvider><div data-theme={theme}><WorkspaceConfigurationDialog workspaces={[]} onClose={vi.fn()} onSaved={vi.fn()} /></div></TooltipProvider>);
	fireEvent.change(screen.getByRole("textbox", { name: "home.description" }), { target: { value: "Math lesson planning" } });
	fireEvent.click(screen.getByRole("button", { name: "home.generate" }));
	return screen.findByRole("button", { name: `home.importSkill ${librarySkill.name}` });
}

describe("workspace skill recommendations", () => {
	it.each(["light", "dark"] as const)("offers a recommended import in %s and keeps it selected when the catalog finishes loading", async (theme) => {
		let finishCatalog!: (items: typeof librarySkill[]) => void;
		mocks.listSkillLibrary.mockReturnValue(new Promise((resolve) => { finishCatalog = resolve; }));
		mocks.importFromLibrary.mockResolvedValue({ ...localSkill, name: "exam2knowledge" });

		const importButton = await generate(theme);
		expect(within(importButton.parentElement!).getByText("home.recommended")).toBeTruthy();
		const alternative = screen.getByRole<HTMLInputElement>("checkbox", { name: "class-exam-review home.alternativeSkill" });
		expect(alternative.checked).toBe(false);
		const alternativeImport = screen.getByRole("button", { name: "home.importSkill math-tutor" });
		expect(within(alternativeImport.parentElement!).getByText("home.alternativeSkill")).toBeTruthy();
		fireEvent.click(importButton);
		const checkbox = await screen.findByRole<HTMLInputElement>("checkbox", { name: /^exam2knowledge/ });
		expect(checkbox.checked).toBe(true);
		await act(async () => finishCatalog([librarySkill]));
		expect(screen.queryByRole("button", { name: `home.importSkill ${librarySkill.name}` })).toBeNull();
		fireEvent.click(alternative);

		fireEvent.click(screen.getByRole("button", { name: "workspace.newWorkspace" }));
		await waitFor(() => expect(mocks.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({
			skillNames: [localSkill.name, "exam2knowledge", localAlternative.name],
		})));
	});

	it("saves the local recommendation without importing an unselected library skill", async () => {
		await generate("light");
		fireEvent.click(screen.getByRole("button", { name: "workspace.newWorkspace" }));
		await waitFor(() => expect(mocks.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ skillNames: [localSkill.name] })));
		expect(mocks.importFromLibrary).not.toHaveBeenCalled();
	});

	it("defaults pin-to-home to checked and fills description from starter prompts", async () => {
		const onSaved = vi.fn();
		render(<TooltipProvider><WorkspaceConfigurationDialog workspaces={[]} onClose={vi.fn()} onSaved={onSaved} /></TooltipProvider>);
		fireEvent.click(screen.getByRole("button", { name: "home.starterLesson" }));
		expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "home.description" }).value).toBe("home.starterLesson");

		fireEvent.click(screen.getByRole("radio", { name: "home.manual" }));
		const pinCheckbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "home.pin" });
		expect(pinCheckbox.checked).toBe(true);

		fireEvent.change(screen.getByRole("textbox", { name: /home\.name/ }), { target: { value: "Math Prep" } });
		fireEvent.click(screen.getByRole("button", { name: "workspace.newWorkspace" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: "math" }, true));
	});

	it("supports inline AI skill suggestions in edit mode without a top mode switcher", async () => {
		const onSaved = vi.fn();
		const existing = { id: "ws-edit", name: "Math Studio", relPath: "ws-edit", isTemp: false, purpose: "Study", skillNames: [localSkill.name], privateSkillNames: ["lean-setup"], linkedWorkspaceIds: [], createdAt: "", updatedAt: "" };
		render(<TooltipProvider><WorkspaceConfigurationDialog workspace={existing} workspaces={[existing]} onClose={vi.fn()} onSaved={onSaved} /></TooltipProvider>);

		expect(screen.queryByRole("radiogroup", { name: "home.configurationMode" })).toBeNull();
		expect(screen.getByText("lean-setup")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "home.aiRecommendSkills" }));
		fireEvent.change(screen.getByRole("textbox", { name: "home.description" }), { target: { value: "Exam review" } });
		fireEvent.click(screen.getByRole("button", { name: "home.aiRecommendAction" }));

		expect(await screen.findByRole("button", { name: `home.importSkill ${librarySkill.name}` })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: `home.removeSkill ${localSkill.name}` }));
		fireEvent.click(screen.getByRole("button", { name: "common.save" }));
		await waitFor(() => expect(mocks.updateWorkspace).toHaveBeenCalledWith("ws-edit", expect.objectContaining({
			name: "Math Studio",
			skillNames: [],
		})));
		expect(onSaved).toHaveBeenCalledWith({ id: "ws-edit", name: "Updated Math" }, false);
	});
});
