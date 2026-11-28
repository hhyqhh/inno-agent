import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronDown, Download, Folder, FolderPlus, Lock, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { ApiError } from "../../api/client.js";
import { generateWorkspaceDraft, type WorkspaceMeta } from "../../api/workspaces.js";
import { listSkillLibrary, listSkills } from "../../api/skills.js";
import type { SkillInfo } from "../../types/skills.js";
import { skillsStore } from "../../stores/skills-store.js";
import { workspacesStore } from "../../stores/workspaces-store.js";
import { WorkingLogo } from "../chat/WorkingLogo.js";
import { Button, Checkbox, Dialog, IconButton, Input, SegmentedControl, Spinner, Textarea, Tooltip } from "../ui/index.js";
import "./home.css";

type Page = "describe" | "manual" | "loading" | "review";
type SkillFilter = "all" | "recommended" | "ready" | "library";
type Skill = Pick<SkillInfo, "name" | "description" | "category"> & {
	status: "ready" | "disabled" | "library";
	importedFrom?: string;
};

const STARTER_KEYS = ["home.starterLesson", "home.starterPaper", "home.starterCoding"] as const;

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
	const [pin, setPin] = useState(!workspace);
	const [skills, setSkills] = useState<Skill[]>([]);
	const [showSkills, setShowSkills] = useState(false);
	const [skillFilter, setSkillFilter] = useState<SkillFilter>("all");
	const [query, setQuery] = useState("");
	const [catalogState, setCatalogState] = useState<"loading" | "complete" | "partial">("loading");
	const [importing, setImporting] = useState<string>();
	const [suggestedSkills, setSuggestedSkills] = useState<string[]>([]);
	const [alternativeSkillNames, setAlternativeSkillNames] = useState<string[]>([]);
	const [showInlineAi, setShowInlineAi] = useState(false);
	const [inlineAiPrompt, setInlineAiPrompt] = useState("");
	const [inlineAiLoading, setInlineAiLoading] = useState(false);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const request = useRef<AbortController | null>(null);
	const submit = useRef(false);
	const heading = useRef<HTMLHeadingElement>(null);
	const describeInputRef = useRef<HTMLTextAreaElement>(null);
	const inlineAiInputRef = useRef<HTMLInputElement>(null);
	const title = workspace ? t("home.editWorkspace") : t("workspace.newWorkspace");
	const privateSkillNames = workspace?.privateSkillNames ?? [];
	const privateSkillSet = new Set(privateSkillNames);
	const availableLinks = workspaces.filter((item) => !item.isTemp && !item.id.startsWith("channel-") && item.id !== workspace?.id);
	const hasRecommendations = suggestedSkills.length > 0 || alternativeSkillNames.length > 0;
	const totalSelectedSkills = privateSkillNames.length + skillNames.filter((key) => !privateSkillSet.has(key)).length;
	const selectedPublicSkills = skillNames.filter((key) => !privateSkillSet.has(key));
	const skillDescriptionByName = new Map(skills.map((skill) => [skill.name, skill.description]));

	useEffect(() => () => request.current?.abort(), []);
	useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [page]);
	useEffect(() => {
		if (showInlineAi) inlineAiInputRef.current?.focus();
	}, [showInlineAi]);
	useEffect(() => {
		let active = true;
		void Promise.allSettled([listSkills(), listSkillLibrary()]).then(([installed, library]) => {
			if (!active) return;
			setSkills((current) => {
				const catalog = new Map<string, Skill>((library.status === "fulfilled" ? library.value : [])
					.filter((item) => !item.installed)
					.map((item) => [item.name, { ...item, status: "library" }]));
				for (const item of installed.status === "fulfilled" ? installed.value : []) {
					catalog.set(item.name, { ...item, status: item.enabled && item.loaded ? "ready" : "disabled" });
				}
				// The draft and its imports may finish before the initial catalog request.
				for (const item of current) {
					if (item.importedFrom) catalog.delete(item.importedFrom);
					if (item.status !== "library" || !catalog.has(item.name)) catalog.set(item.name, item);
				}
				return [...catalog.values()];
			});
			setCatalogState(installed.status === "fulfilled" && library.status === "fulfilled" ? "complete" : "partial");
		});
		return () => { active = false; };
	}, []);

	const toggle = (names: string[], value: string) => names.includes(value) ? names.filter((item) => item !== value) : [...names, value];

	const showSkillBrowser = showSkills || hasRecommendations;
	const activeFilter: SkillFilter = skillFilter === "recommended" && !hasRecommendations ? "all" : skillFilter;
	const visibleSkills = skills.filter((skill) => {
		if (privateSkillSet.has(skill.name)) return false;
		if (!showSkills) {
			return suggestedSkills.includes(skill.name) || alternativeSkillNames.includes(skill.name);
		}
		if (activeFilter === "recommended" && !suggestedSkills.includes(skill.name) && !alternativeSkillNames.includes(skill.name)) return false;
		if (activeFilter === "ready" && skill.status === "library") return false;
		if (activeFilter === "library" && skill.status !== "library") return false;
		if (query.trim()) {
			return `${skill.name} ${skill.category ?? ""} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase());
		}
		return true;
	}).sort((a, b) => {
		const recRank = (item: Skill) => suggestedSkills.includes(item.name) ? 2 : alternativeSkillNames.includes(item.name) ? 1 : 0;
		const recDiff = recRank(b) - recRank(a);
		if (recDiff) return recDiff;
		const selectedDiff = Number(skillNames.includes(b.name)) - Number(skillNames.includes(a.name));
		if (selectedDiff) return selectedDiff;
		return a.name.localeCompare(b.name);
	});

	async function runDraftRequest(prompt: string, inline: boolean) {
		if (!prompt.trim() || request.current) return;
		const controller = new AbortController();
		request.current = controller;
		setError("");
		if (inline) setInlineAiLoading(true);
		else setPage("loading");
		try {
			const draft = await generateWorkspaceDraft(prompt.trim(), workspace?.id, controller.signal);
			if (controller.signal.aborted) return;
			const librarySkills = draft.librarySkills ?? [];
			const alternatives = draft.alternativeSkills ?? [];
			const nextSuggested = [...draft.skillNames, ...librarySkills.map((skill) => skill.name)];
			const nextAlternatives = alternatives.map((skill) => skill.name);
			setSuggestedSkills(nextSuggested);
			setAlternativeSkillNames(nextAlternatives);
			setSkills((current) => [
				...current,
				...[...librarySkills, ...alternatives].filter((skill) => !current.some((item) => item.name === skill.name))
					.map<Skill>((skill) => ({ ...skill, status: skill.installed ? "ready" : "library" })),
			]);
			if (nextSuggested.length > 0 || nextAlternatives.length > 0) {
				setSkillFilter("recommended");
			}
			if (!workspace) {
				setName(draft.name);
				setPurpose(draft.purpose);
				setSkillNames(draft.skillNames);
				setLinks(draft.linkedWorkspaceIds);
				setPage("review");
			} else {
				setShowInlineAi(false);
				setShowSkills(true);
			}
		} catch (err) {
			if (!controller.signal.aborted) {
				const reason = err instanceof ApiError && typeof err.data?.reason === "string" ? err.data.reason : "";
				setError(reason ? `${t("home.generateError")} (${reason})` : t("home.generateError"));
				if (!inline) setPage("describe");
			}
		} finally {
			if (request.current === controller) request.current = null;
			if (inline) setInlineAiLoading(false);
		}
	}

	async function save() {
		if (!name.trim() || submit.current || importing || inlineAiLoading) return;
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
			const installed = await skillsStore.importFromLibrary(skill.name);
			if (!installed?.enabled) throw new Error("Imported skill unavailable");
			setSkills((previous) => [
				...previous.filter((item) => item.name !== skill.name && item.name !== installed.name),
				{ ...installed, status: "ready", importedFrom: skill.name },
			]);
			setSuggestedSkills((previous) => previous.map((item) => item === skill.name ? installed.name : item));
			setAlternativeSkillNames((previous) => previous.map((item) => item === skill.name ? installed.name : item));
			setSkillNames((previous) => [...new Set([...previous, installed.name])]);
		} catch {
			setError(t("home.importError"));
		} finally {
			setImporting(undefined);
		}
	}

	function stopGeneration() {
		request.current?.abort();
		request.current = null;
		setInlineAiLoading(false);
		if (!workspace) setPage("describe");
	}

	function applyStarter(prompt: string) {
		setDescription(prompt);
		setError("");
		requestAnimationFrame(() => {
			const textarea = describeInputRef.current;
			if (!textarea) return;
			textarea.focus();
			textarea.setSelectionRange(prompt.length, prompt.length);
		});
	}

	const editingForm = page === "manual" || page === "review";
	const busy = saving || Boolean(importing) || inlineAiLoading;

	return (
		<Dialog label={title} className="inno-confirm-dialog inno-home-dialog inno-ws-dialog" onClose={() => { if (!submit.current && !importing && !inlineAiLoading) onClose(); }}>
			<header className="inno-home-dialog-header inno-ws-dialog-header">
				<div className="inno-ws-dialog-title-group">
					<span className="inno-ws-dialog-icon" aria-hidden="true">
						{workspace ? <SlidersHorizontal size={16} /> : <FolderPlus size={16} />}
					</span>
					<div className="inno-ws-dialog-titles">
						<h2 ref={heading} tabIndex={-1} className="text-base font-semibold leading-tight">{title}</h2>
						<p className="inno-ws-dialog-subtitle text-xs">
							{t(workspace ? "home.editWorkspaceSubtitle" : "home.newWorkspaceSubtitle")}
						</p>
					</div>
				</div>
				<div className="inno-ws-dialog-header-actions">
					{!workspace && (page === "manual" || page === "describe") ? (
						<SegmentedControl<Page> value={page} ariaLabel={t("home.configurationMode")} onValueChange={(next) => { setError(""); setPage(next); }} items={[
							{ value: "describe", label: t("home.describe") },
							{ value: "manual", label: t("home.manual") },
						]} />
					) : null}
					<IconButton aria-label={t("common.cancel")} disabled={busy} onClick={onClose}><X size={16} /></IconButton>
				</div>
			</header>
			<form className="inno-home-dialog-form" onSubmit={(event) => {
				event.preventDefault();
				if (page === "describe") void runDraftRequest(description, false);
				else if (editingForm) void save();
			}}>
				<div className="inno-ws-dialog-body">
					<motion.div key={page} initial={reduceMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
						{page === "describe" ? (
							<div className="inno-ws-describe">
								<div className="inno-ws-describe-intro">
									<div className="text-sm font-medium">{t("home.describeHeading")}</div>
									<p className="text-xs text-[var(--inno-text-subtle)]">{t("home.describeHelper")}</p>
								</div>
								<div>
									<Textarea
										ref={describeInputRef}
										aria-label={t("home.description")}
										autoFocus
										rows={5}
										maxLength={4000}
										placeholder={t("home.workspacePrompt")}
										className="resize-none"
										value={description}
										onChange={(event) => setDescription(event.target.value)}
										onKeyDown={(event) => {
											if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && description.trim()) {
												event.preventDefault();
												void runDraftRequest(description, false);
											}
										}}
									/>
									<div className="inno-ws-describe-meta text-xs">
										<span>{t("home.describeHint")}</span>
										<span className="tabular-nums">{description.length} / 4000</span>
									</div>
								</div>
								<div className="inno-ws-starters">
									<div className="text-xs font-medium text-[var(--inno-text-subtle)]">{t("home.starterHeading")}</div>
									<div className="inno-ws-starter-list">
										{STARTER_KEYS.map((key) => {
											const text = t(key);
											return (
												<button key={key} type="button" className="inno-ws-starter-chip text-xs" onClick={() => applyStarter(text)}>
													{text}
												</button>
											);
										})}
									</div>
								</div>
							</div>
						) : null}

						{page === "loading" ? (
							<div className="inno-home-loading" role="status">
								<WorkingLogo className="inno-ws-loading-logo" />
								<div className="text-sm font-medium text-[var(--inno-text)]">{t("home.generating")}</div>
								<p className="text-xs text-[var(--inno-text-subtle)]">{t("home.generatingDetail")}</p>
							</div>
						) : null}

						{editingForm ? (
							<div className="inno-ws-form-sections">
								{page === "review" ? (
									<div className="inno-ws-review-banner text-xs" role="status">
										<Sparkles size={14} className="inno-ws-review-banner-icon" aria-hidden="true" />
										<div>
											<span className="font-medium">{t("home.reviewBannerTitle")}</span>
											<span className="text-[var(--inno-text-muted)]"> — {t("home.reviewBannerBody")}</span>
										</div>
									</div>
								) : null}

								<section className="inno-ws-section">
									<label className="inno-ws-field">
										<span className="text-sm font-medium">
											{t("home.name")}<span className="inno-ws-required" aria-hidden="true">*</span>
										</span>
										<Input value={name} maxLength={120} placeholder={t("home.namePlaceholder")} onChange={(event) => setName(event.target.value)} required />
									</label>

									<label className="inno-ws-field">
										<span className="inno-ws-field-header">
											<span className="text-sm font-medium">{t("home.purpose")}</span>
											<span className="text-xs text-[var(--inno-text-subtle)]">{t("home.optional")} · {t("home.purposeHint")}</span>
										</span>
										<Textarea className="resize-none" rows={2} maxLength={2000} placeholder={t("home.purposePlaceholder")} value={purpose} onChange={(event) => setPurpose(event.target.value)} />
									</label>
								</section>

								<fieldset className="inno-ws-section">
									<div className="inno-ws-section-header">
										<div className="inno-ws-section-title">
											<legend className="text-sm font-medium">{t("home.skills")}</legend>
											<span className="inno-ws-count-pill text-xs">{t("home.selectedCount", { count: totalSelectedSkills })}</span>
										</div>
										<div className="inno-ws-section-actions">
											{workspace ? (
												<Button variant={showInlineAi ? "primary" : "ghost"} size="xs" aria-pressed={showInlineAi} disabled={busy} onClick={() => setShowInlineAi((prev) => !prev)}>
													<Sparkles size={13} />{t("home.aiRecommendSkills")}
												</Button>
											) : null}
											<Button variant="secondary" size="xs" aria-expanded={showSkills} onClick={() => {
												const next = !showSkills;
												setShowSkills(next);
												if (next && activeFilter === "recommended" && !hasRecommendations) setSkillFilter("all");
											}}>
												{t(showSkills ? "home.showSelected" : "home.browseSkills")}
												<ChevronDown size={13} style={{ transform: showSkills ? "rotate(180deg)" : undefined, transition: "transform var(--inno-dur-fast) var(--inno-ease-out)" }} />
											</Button>
										</div>
									</div>

									{workspace && showInlineAi ? (
										<div className="inno-ws-ai-inline">
											<div className="text-xs font-medium">{t("home.aiRecommendHeading")}</div>
											<div className="inno-ws-ai-inline-row">
												<Input
													ref={inlineAiInputRef}
													size="sm"
													aria-label={t("home.description")}
													placeholder={t("home.skillPrompt")}
													value={inlineAiPrompt}
													disabled={inlineAiLoading}
													onChange={(event) => setInlineAiPrompt(event.target.value)}
													onKeyDown={(event) => {
														if (event.key === "Enter") {
															event.preventDefault();
															void runDraftRequest(inlineAiPrompt, true);
														}
													}}
												/>
												{inlineAiLoading ? (
													<Button variant="secondary" size="xs" onClick={stopGeneration}>{t("common.cancel")}</Button>
												) : (
													<Button variant="primary" size="xs" disabled={!inlineAiPrompt.trim()} onClick={() => void runDraftRequest(inlineAiPrompt, true)}>
														<Sparkles size={13} />{t("home.aiRecommendAction")}
													</Button>
												)}
											</div>
											{inlineAiLoading ? (
												<div className="flex items-center gap-2 text-xs text-[var(--inno-text-subtle)]" role="status">
													<WorkingLogo />
													<span>{t("home.aiRecommending")}</span>
												</div>
											) : null}
										</div>
									) : null}

									{totalSelectedSkills > 0 ? (
										<div className="inno-ws-selected-skills">
											{privateSkillNames.map((key) => (
												<span className="inno-ws-skill-tag inno-ws-skill-tag--private text-xs" key={`private:${key}`}>
													<Lock size={11} className="inno-ws-skill-tag-lock" aria-hidden="true" />
													<span className="font-medium">{key}</span>
													<span className="inno-ws-skill-tag-meta">{t("home.privateSkill")}</span>
												</span>
											))}
											{selectedPublicSkills.map((key) => {
												const desc = skillDescriptionByName.get(key);
												const tag = (
													<span className="inno-ws-skill-tag text-xs" key={`selected:${key}`}>
														<span className="font-medium">{key}</span>
														<button
															type="button"
															className="inno-ws-skill-tag-remove"
															aria-label={t("home.removeSkill", { name: key })}
															disabled={busy}
															onClick={() => setSkillNames(toggle(skillNames, key))}
														>
															<X size={12} />
														</button>
													</span>
												);
												return desc ? (
													<Tooltip key={`selected:${key}`} label={key} description={desc} side="top" contentClassName="inno-ws-skill-tooltip">
														{tag}
													</Tooltip>
												) : tag;
											})}
										</div>
									) : (
										<div className="inno-ws-empty-skills text-xs">
											<span>{t("home.noSkillsSelected")}</span>
											{!showSkills ? (
												<Button variant="ghost" size="xs" onClick={() => setShowSkills(true)}>
													{t("home.selectSkillsAction")}
												</Button>
											) : null}
										</div>
									)}

									{showSkillBrowser ? (
										<div className="inno-ws-skill-browser">
											{showSkills ? (
												<div className="inno-ws-skill-browser-head">
													<div className="inno-ws-search-wrap">
														<Search size={14} className="inno-ui-input-leading-adornment" aria-hidden="true" />
														<Input
															size="sm"
															hasLeadingAdornment
															hasTrailingAdornment={Boolean(query)}
															aria-label={t("home.searchSkills")}
															placeholder={t("home.searchSkills")}
															value={query}
															onChange={(event) => setQuery(event.target.value)}
															onKeyDown={(event) => {
																if (event.key === "Enter") event.preventDefault();
															}}
														/>
														{query ? (
															<IconButton
																size="compact"
																className="inno-ws-search-clear"
																aria-label={t("home.clearSearch")}
																onClick={() => setQuery("")}
															>
																<X size={12} />
															</IconButton>
														) : null}
													</div>
													<div className="inno-ws-filter-pills">
														{([
															{ id: "all", label: t("home.skillFilterAll") },
															...(hasRecommendations ? [{ id: "recommended" as const, label: t("home.skillFilterRecommended") }] : []),
															{ id: "ready", label: t("home.skillFilterReady") },
															{ id: "library", label: t("home.skillFilterLibrary") },
														] as const).map((tab) => (
															<Button
																key={tab.id}
																size="xs"
																shape="pill"
																variant={activeFilter === tab.id ? "primary" : "secondary"}
																aria-pressed={activeFilter === tab.id}
																onClick={() => setSkillFilter(tab.id)}
															>
																{tab.label}
															</Button>
														))}
													</div>
												</div>
											) : null}

											{catalogState !== "complete" ? (
												<p className="px-3 py-2 text-xs text-[var(--inno-text-muted)] border-b border-[var(--inno-border)]" role="status">
													{t(catalogState === "loading" ? "home.loadingSkills" : "home.partialSkills")}
												</p>
											) : null}

											<div className="inno-ws-skill-list">
												{visibleSkills.length === 0 ? (
													<div className="inno-ws-skill-empty text-xs">{t("home.noMatchingSkills")}</div>
												) : visibleSkills.map((skill) => {
													const badge = suggestedSkills.includes(skill.name) ? t("home.recommended")
														: alternativeSkillNames.includes(skill.name) ? t("home.alternativeSkill") : null;
													const isRecommended = suggestedSkills.includes(skill.name);
													const isChecked = skillNames.includes(skill.name);
													const isDisabled = skill.status === "disabled" && !isChecked;

													const rowMain = (
														<div className="inno-ws-skill-row-main">
															<div className="inno-ws-skill-row-top">
																<span className="inno-ws-skill-name text-sm">{skill.name}</span>
																{skill.category ? <span className="inno-ws-badge text-xs">{skill.category}</span> : null}
																{skill.status !== "library" && badge ? (
																	<span className={`inno-ws-badge text-xs${isRecommended ? " inno-ws-badge--accent" : ""}`}>{badge}</span>
																) : null}
																{skill.status === "disabled" ? <span className="inno-ws-badge text-xs">{t("common.disabled")}</span> : null}
															</div>
															{skill.description ? <p className="inno-ws-skill-desc text-xs">{skill.description}</p> : null}
														</div>
													);
													const rowMainWithTooltip = skill.description ? (
														<Tooltip label={skill.name} description={skill.description} side="top" align="start" contentClassName="inno-ws-skill-tooltip">
															{rowMain}
														</Tooltip>
													) : rowMain;

													if (skill.status === "library") {
														return (
															<div className="inno-ws-skill-row" key={skill.name}>
																<span className="inno-ws-skill-row-icon" aria-hidden="true"><Download size={14} /></span>
																{rowMainWithTooltip}
																{badge ? <span className={`inno-ws-badge text-xs${isRecommended ? " inno-ws-badge--accent" : ""}`}>{badge}</span> : null}
																<Button
																	variant="secondary"
																	size="xs"
																	disabled={Boolean(importing)}
																	aria-label={t("home.importSkill", { name: skill.name })}
																	onClick={() => void importSkill(skill)}
																>
																	{importing === skill.name ? <Spinner size={12} /> : <Download size={12} />}
																	{t(importing === skill.name ? "home.importingAction" : "home.importAction")}
																</Button>
															</div>
														);
													}

													return (
														<label
															className={`inno-ws-skill-row inno-ws-skill-row--selectable${isDisabled ? " inno-ws-skill-row--disabled" : ""}`}
															key={skill.name}
														>
															<Checkbox
																aria-label={badge ? `${skill.name} ${badge}` : skill.name}
																checked={isChecked}
																disabled={isDisabled}
																onChange={() => setSkillNames(toggle(skillNames, skill.name))}
															/>
															{rowMainWithTooltip}
														</label>
													);
												})}
											</div>
										</div>
									) : null}
								</fieldset>

								{availableLinks.length ? (
									<fieldset className="inno-ws-section">
										<div className="inno-ws-section-header">
											<div className="inno-ws-section-title">
												<legend className="text-sm font-medium">{t("home.links")}</legend>
												{links.length > 0 ? <span className="inno-ws-count-pill text-xs">{links.length}</span> : null}
											</div>
											<span className="text-xs text-[var(--inno-text-subtle)]">{t("home.optional")} · {t("home.linksHint")}</span>
										</div>
										<div className="inno-ws-link-grid">
											{availableLinks.map((item) => {
												const count = (item.skillNames?.length ?? 0) + (item.privateSkillNames?.length ?? 0);
												return (
													<label className="inno-ws-link-card" key={item.id}>
														<span className="inno-ws-link-icon" aria-hidden="true"><Folder size={14} /></span>
														<span className="inno-ws-link-info">
															<span className="inno-ws-link-name text-sm">{item.name}</span>
															{count > 0 ? <span className="inno-ws-link-meta text-xs">{t("home.skillCount", { count })}</span> : null}
														</span>
														<Checkbox checked={links.includes(item.id)} onChange={() => setLinks(toggle(links, item.id))} />
													</label>
												);
											})}
										</div>
									</fieldset>
								) : null}
							</div>
						) : null}
					</motion.div>
					{error ? <p role="alert" className="text-sm text-[var(--inno-danger)]">{error}</p> : null}
				</div>

				<footer className="inno-home-dialog-footer inno-ws-dialog-footer">
					<div className="inno-ws-dialog-footer-left">
						{page === "review" ? (
							<Button variant="ghost" size="sm" disabled={busy} onClick={() => setPage("describe")}>
								<ArrowLeft size={14} />{t("home.reviseDescription")}
							</Button>
						) : null}
						{!workspace && editingForm ? (
							<label className="inno-ws-pin-label text-sm">
								<Checkbox checked={pin} onChange={(event) => setPin(event.target.checked)} />
								<span>{t("home.pin")}</span>
							</label>
						) : null}
						{!workspace && page === "describe" ? (
							<span className="text-xs text-[var(--inno-text-subtle)]">{t("home.describeShortcut")}</span>
						) : null}
					</div>
					<div className="inno-ws-dialog-footer-right">
						{page === "loading" ? (
							<Button onClick={stopGeneration}>{t("common.cancel")}</Button>
						) : (
							<>
								<Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
								<Button type="submit" variant="primary" disabled={page === "describe" ? !description.trim() : !name.trim() || busy}>
									{page === "describe" ? <><Sparkles size={15} />{t("home.generate")}</> : workspace ? t("common.save") : title}
								</Button>
							</>
						)}
					</div>
				</footer>
			</form>
		</Dialog>
	);
}
