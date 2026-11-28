import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListChecks, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { generateWorkspaceDraft, type WorkspaceMeta } from "../../api/workspaces.js";
import { listSkillLibrary, listSkills } from "../../api/skills.js";
import type { SkillInfo, SkillLibraryItem } from "../../types/skills.js";
import { skillsStore } from "../../stores/skills-store.js";
import { workspacesStore } from "../../stores/workspaces-store.js";
import { Button, Checkbox, Dialog, IconButton, Input, SegmentedControl, Spinner, Textarea } from "../ui/index.js";

type Page = "describe" | "manual" | "loading" | "review";
type Skill = Pick<SkillInfo, "name" | "description" | "category"> & { status: "ready" | "disabled" | "library" };

export function WorkspaceConfigurationDialog({ workspace, workspaces, onClose, onSaved }: {
	workspace?: WorkspaceMeta;
	workspaces: WorkspaceMeta[];
	onClose: () => void;
	onSaved: (workspace: WorkspaceMeta, pin: boolean) => void;
}) {
	const { t } = useTranslation();
	const reduceMotion = useReducedMotion();
	const [page, setPage] = useState<Page>(workspace ? "manual" : "describe");
	const [description, setDescription] = useState("");
	const [name, setName] = useState(workspace?.name ?? "");
	const [purpose, setPurpose] = useState(workspace?.purpose ?? "");
	const [skillNames, setSkillNames] = useState(workspace?.skillNames ?? []);
	const [links, setLinks] = useState(workspace?.linkedWorkspaceIds ?? []);
	const [pin, setPin] = useState(false);
	const [skills, setSkills] = useState<Skill[]>([]);
	const [showSkills, setShowSkills] = useState(false);
	const [query, setQuery] = useState("");
	const [catalogState, setCatalogState] = useState<"loading" | "complete" | "partial">("loading");
	const [importing, setImporting] = useState<string>();
	const [suggestedSkills, setSuggestedSkills] = useState<string[]>([]);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const request = useRef<AbortController | null>(null);
	const submit = useRef(false);
	const heading = useRef<HTMLHeadingElement>(null);
	const title = workspace ? t("home.editWorkspace") : t("workspace.newWorkspace");
	const availableLinks = workspaces.filter((item) => !item.isTemp && !item.id.startsWith("channel-") && item.id !== workspace?.id);

	useEffect(() => () => request.current?.abort(), []);
	useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [page]);
	useEffect(() => {
		let active = true;
		void Promise.allSettled([listSkills(), listSkillLibrary()]).then(([installed, library]) => {
			if (!active) return;
			const catalog = new Map<string, Skill>((library.status === "fulfilled" ? library.value : [])
				.map((item: SkillLibraryItem) => [item.name, { ...item, status: "library" }]));
			for (const item of installed.status === "fulfilled" ? installed.value : []) {
				catalog.set(item.name, { ...item, status: item.enabled && item.loaded ? "ready" : "disabled" });
			}
			setSkills([...catalog.values()].sort((a, b) => a.name.localeCompare(b.name)));
			setCatalogState(installed.status === "fulfilled" && library.status === "fulfilled" ? "complete" : "partial");
		});
		return () => { active = false; };
	}, []);

	const toggle = (names: string[], value: string) => names.includes(value) ? names.filter((item) => item !== value) : [...names, value];
	const visibleSkills = skills.filter((skill) => {
		if (!showSkills) return skillNames.includes(skill.name) || suggestedSkills.includes(skill.name);
		return `${skill.name} ${skill.category ?? ""} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase());
	});

	async function generate() {
		if (!description.trim() || request.current) return;
		const controller = new AbortController();
		request.current = controller;
		setError("");
		setPage("loading");
		try {
			const draft = await generateWorkspaceDraft(description.trim(), workspace?.id, controller.signal);
			if (controller.signal.aborted) return;
			setSuggestedSkills(draft.skillNames);
			if (!workspace) {
				setName(draft.name);
				setPurpose(draft.purpose);
				setSkillNames(draft.skillNames);
				setLinks(draft.linkedWorkspaceIds);
			}
			setPage("review");
		} catch {
			if (!controller.signal.aborted) {
				setError(t("home.generateError"));
				setPage("describe");
			}
		} finally {
			if (request.current === controller) request.current = null;
		}
	}

	async function save() {
		if (!name.trim() || submit.current || importing) return;
		submit.current = true;
		setSaving(true);
		setError("");
		try {
			const validLinks = new Set(availableLinks.map((item) => item.id));
			const input = { name: name.trim(), purpose, skillNames, linkedWorkspaceIds: links.filter((id) => validLinks.has(id)) };
			const saved = workspace ? await workspacesStore.update(workspace.id, input) : await workspacesStore.create(input);
			onSaved(saved, pin);
		} catch {
			setError(t("home.saveError"));
		} finally {
			submit.current = false;
			setSaving(false);
		}
	}

	async function importSkill(skill: Skill) {
		if (importing) return;
		setImporting(skill.name);
		setError("");
		try {
			await skillsStore.importFromLibrary(skill.name);
			const installed = (await listSkills()).find((item) => item.name === skill.name);
			if (!installed?.enabled) throw new Error("Imported skill unavailable");
			setSkills((previous) => previous.map((item) => item.name === skill.name ? { ...installed, status: "ready" } : item));
			setSkillNames((previous) => previous.includes(skill.name) ? previous : [...previous, skill.name]);
		} catch {
			setError(t("home.importError"));
		} finally {
			setImporting(undefined);
		}
	}

	function stopGeneration() {
		request.current?.abort();
		request.current = null;
		setPage("describe");
	}

	const editingForm = page === "manual" || page === "review";
	return (
		<Dialog label={title} className="inno-confirm-dialog inno-home-dialog" onClose={() => { if (!submit.current && !importing) onClose(); }}>
			<header className="inno-home-dialog-header">
				<h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">{title}</h2>
				<IconButton aria-label={t("common.cancel")} disabled={saving || Boolean(importing)} onClick={onClose}><X size={16} /></IconButton>
			</header>
			<form className="inno-home-dialog-form" onSubmit={(event) => {
				event.preventDefault();
				if (page === "describe") void generate();
				else if (editingForm) void save();
			}}>
				<div className="inno-home-dialog-body">
					{page === "manual" || page === "describe" ? (
						<SegmentedControl<Page> value={page} ariaLabel={t("home.configurationMode")} onValueChange={(next) => { setError(""); setPage(next); }} items={[
							{ value: "describe", label: t(workspace ? "home.findSkills" : "home.describe") },
							{ value: "manual", label: t("home.manual") },
						]} />
					) : null}
					<motion.div key={page} initial={reduceMotion ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }} className="grid gap-4">
						{page === "describe" ? <Textarea aria-label={t("home.description")} autoFocus rows={5} maxLength={4000} placeholder={t(workspace ? "home.skillPrompt" : "home.workspacePrompt")}
							className="resize-none" value={description} onChange={(event) => setDescription(event.target.value)} /> : null}
						{page === "loading" ? <div className="inno-home-loading text-sm" role="status"><Spinner size={22} className="motion-reduce:animate-none" />{t("home.generating")}</div> : null}
						{editingForm ? <>
							<label className="grid gap-1 text-sm">{t("home.name")}<Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} required /></label>
							<label className="grid gap-1 text-sm">{t("home.purpose")}<Textarea className="resize-none" rows={3} maxLength={2000} value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
							<fieldset className="grid gap-2">
								<legend className="text-sm font-medium">{t("home.skills")}</legend>
								<Button variant="ghost" className="justify-self-start" onClick={() => setShowSkills(!showSkills)}>{t(showSkills ? "home.showSelected" : "home.browseSkills")}</Button>
								{showSkills ? <Input aria-label={t("home.searchSkills")} placeholder={t("home.searchSkills")} value={query} onChange={(event) => setQuery(event.target.value)} /> : null}
								{catalogState !== "complete" ? <p className="text-xs text-[var(--inno-text-muted)]" role="status">{t(catalogState === "loading" ? "home.loadingSkills" : "home.partialSkills")}</p> : null}
								<div className="inno-home-choices">
									{visibleSkills.map((skill) => <div className="inno-home-choice" key={skill.name}>
										{skill.status === "library" ? <Button variant="ghost" size="xs" disabled={Boolean(importing)} title={skill.description} onClick={() => void importSkill(skill)}>{t("home.importSkill", { name: skill.name })}</Button> :
											<label title={skill.description}><Checkbox checked={skillNames.includes(skill.name)} disabled={skill.status === "disabled" && !skillNames.includes(skill.name)} onChange={() => setSkillNames(toggle(skillNames, skill.name))} />
												{skill.name}{suggestedSkills.includes(skill.name) ? <small>{t("home.recommended")}</small> : null}{skill.status === "disabled" ? <small>{t("common.disabled")}</small> : null}
											</label>}
									</div>)}
									{skillNames.filter((key) => !skills.some((skill) => skill.name === key)).map((key) => <label className="inno-home-choice" key={key}>
										<Checkbox checked onChange={() => setSkillNames(toggle(skillNames, key))} />{key}
									</label>)}
								</div>
							</fieldset>
							{availableLinks.length ? <fieldset className="grid gap-2">
								<legend className="text-sm font-medium">{t("home.links")}</legend>
								<div className="inno-home-choices">{availableLinks.map((item) => <label className="inno-home-choice" key={item.id}>
									<Checkbox checked={links.includes(item.id)} onChange={() => setLinks(toggle(links, item.id))} />{item.name}
								</label>)}</div>
							</fieldset> : null}
							{!workspace ? <label className="inno-home-choice text-sm"><Checkbox checked={pin} onChange={(event) => setPin(event.target.checked)} />{t("home.pin")}</label> : null}
						</> : null}
					</motion.div>
					{error ? <p role="alert" className="text-sm text-[var(--inno-danger)]">{error}</p> : null}
				</div>
				<footer className="inno-home-dialog-footer">
					{page === "loading" ? <Button onClick={stopGeneration}>{t("common.cancel")}</Button> : <>
						{page === "review" ? <Button variant="ghost" className="mr-auto" disabled={saving || Boolean(importing)} onClick={() => setPage("describe")}>{t("home.reviseDescription")}</Button> : null}
						<Button disabled={saving || Boolean(importing)} onClick={onClose}>{t("common.cancel")}</Button>
						<Button type="submit" variant="primary" disabled={page === "describe" ? !description.trim() : !name.trim() || saving || Boolean(importing)}>
							{page === "describe" ? <><ListChecks size={15} />{t("home.generate")}</> : workspace ? t("common.save") : title}
						</Button>
					</>}
				</footer>
			</form>
		</Dialog>
	);
}
