import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import { mcpStore } from "../../stores/mcp-store.js";
import { useStoreSnapshot } from "../hooks.js";
import type { InnoSettings } from "../../types/settings.js";
import type { McpServerEntry, McpServerView, McpServerRuntimeStatus } from "../../types/mcp.js";
import { Button, IconButton, Input, Select, SelectContent, SelectOption, SelectTrigger, SelectValue, Switch, Textarea, Tooltip } from "../ui/index.js";
import { SettingsSection, SettingsCard, SettingsRow } from "./primitives.js";

/* ---------- Master switch ---------- */

function McpMasterCard({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const { isSavingMcp } = useStoreSnapshot(settingsStore, () => ({
		isSavingMcp: settingsStore.isSavingMcp,
	}));
	const { adapterLoaded } = useStoreSnapshot(mcpStore, () => ({
		adapterLoaded: mcpStore.overview?.adapterLoaded ?? false,
	}));
	const enabled = settings.mcp?.enabled === true;
	// Config and runtime disagree → the toggle was flipped after boot and the
	// extension set only changes on restart.
	const restartPending = enabled !== adapterLoaded;

	return (
		<SettingsCard>
			<SettingsRow
				label={t("settings.mcp.masterTitle")}
				description={enabled ? t("settings.mcp.masterOnDesc") : t("settings.mcp.masterOffDesc")}
				control={<Switch checked={enabled} onChange={(v) => void settingsStore.saveMcp(v)} disabled={isSavingMcp} />}
			/>
			{restartPending ? (
				<p className="mt-2 text-xs text-[var(--inno-warning)]">{t("settings.mcp.restartHint")}</p>
			) : null}
		</SettingsCard>
	);
}

/* ---------- Server add/edit form ---------- */

type Transport = "stdio" | "http";

interface FormState {
	name: string;
	transport: Transport;
	command: string;
	args: string; // one per line
	env: string; // KEY=VALUE per line
	url: string;
	headers: string; // KEY=VALUE per line
	lifecycle: "" | NonNullable<McpServerEntry["lifecycle"]>;
	directTools: "" | "all";
	jsonMode: boolean;
	json: string;
}

const EMPTY_FORM: FormState = {
	name: "",
	transport: "stdio",
	command: "",
	args: "",
	env: "",
	url: "",
	headers: "",
	lifecycle: "",
	directTools: "",
	jsonMode: false,
	json: "",
};

function linesToRecord(text: string): Record<string, string> | undefined {
	const record: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		record[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
	}
	return Object.keys(record).length > 0 ? record : undefined;
}

function recordToLines(record: Record<string, string> | undefined): string {
	return record ? Object.entries(record).map(([k, v]) => `${k}=${v}`).join("\n") : "";
}

function linesToArray(text: string): string[] | undefined {
	const items = text.split("\n").map((l) => l.trim()).filter(Boolean);
	return items.length > 0 ? items : undefined;
}

/** Fields the structured form can't represent — editing those servers defaults to JSON mode. */
const FORM_SUPPORTED_KEYS = new Set([
	"command", "args", "env", "url", "headers", "lifecycle", "directTools", "disabled",
]);

function formFromServer(view: McpServerView): FormState {
	const def = view.definition;
	const needsJson = Object.keys(def).some((k) => !FORM_SUPPORTED_KEYS.has(k))
		|| Array.isArray(def.directTools);
	return {
		name: view.name,
		transport: def.url ? "http" : "stdio",
		command: def.command ?? "",
		args: (def.args ?? []).join("\n"),
		env: recordToLines(def.env),
		url: def.url ?? "",
		headers: recordToLines(def.headers),
		lifecycle: def.lifecycle ?? "",
		directTools: def.directTools === true ? "all" : "",
		jsonMode: needsJson,
		json: JSON.stringify(def, null, 2),
	};
}

function entryFromForm(form: FormState): McpServerEntry {
	const entry: McpServerEntry = {};
	if (form.transport === "stdio") {
		entry.command = form.command.trim();
		const args = linesToArray(form.args);
		if (args) entry.args = args;
		const env = linesToRecord(form.env);
		if (env) entry.env = env;
	} else {
		entry.url = form.url.trim();
		const headers = linesToRecord(form.headers);
		if (headers) entry.headers = headers;
	}
	if (form.lifecycle) entry.lifecycle = form.lifecycle;
	if (form.directTools === "all") entry.directTools = true;
	return entry;
}

function ServerForm({
	initial,
	onDone,
}: {
	initial: FormState;
	onDone: () => void;
}) {
	const { t } = useTranslation();
	const [form, setForm] = useState<FormState>(initial);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const editing = Boolean(initial.name);

	function patch(partial: Partial<FormState>) {
		setForm((f) => ({ ...f, ...partial }));
		setError(null);
	}

	function toggleJsonMode() {
		if (form.jsonMode) {
			patch({ jsonMode: false });
		} else {
			// Serialize the current form state so nothing entered is lost.
			patch({ jsonMode: true, json: JSON.stringify(entryFromForm(form), null, 2) });
		}
	}

	function buildEntry(): McpServerEntry {
		if (form.jsonMode) {
			const parsed = JSON.parse(form.json) as McpServerEntry;
			return parsed;
		}
		return entryFromForm(form);
	}

	async function handleSave() {
		setSaving(true);
		setError(null);
		try {
			const entry = buildEntry();
			await mcpStore.upsertServer(form.name.trim(), entry);
			onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	const canSave = form.jsonMode
		? form.name.trim().length > 0 && form.json.trim().length > 0
		: form.name.trim().length > 0 && (form.transport === "stdio" ? form.command.trim().length > 0 : form.url.trim().length > 0);

	return (
		<div className="grid gap-2.5 rounded-md border border-[var(--inno-border)] p-3">
			<div className="flex items-center justify-between gap-2">
				<h5 className="text-sm font-medium text-[var(--inno-text)]">
					{editing ? t("settings.mcp.editServer") : t("settings.mcp.addServer")}
				</h5>
				<button
					onClick={toggleJsonMode}
					className="text-xs text-[var(--inno-text-subtle)] hover:text-[var(--inno-text)]"
				>
					{form.jsonMode ? t("settings.mcp.formMode") : t("settings.mcp.jsonMode")}
				</button>
			</div>

			<Input
				size="sm"
				value={form.name}
				onChange={(e) => patch({ name: e.target.value })}
				placeholder={t("settings.mcp.namePlaceholder") ?? ""}
				disabled={editing}
				autoComplete="off"
			/>

			{form.jsonMode ? (
				<Textarea
					className="min-h-40 font-mono"
					value={form.json}
					onChange={(e) => patch({ json: e.target.value })}
					placeholder='{ "command": "npx", "args": ["-y", "some-mcp-server"] }'
					spellCheck={false}
				/>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-1.5">
						{(["stdio", "http"] as Transport[]).map((tr) => (
							<button
								key={tr}
								onClick={() => patch({ transport: tr })}
								className={`flex h-8 items-center rounded-md border px-2.5 text-sm ${form.transport === tr ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"}`}
							>
								{tr === "stdio" ? t("settings.mcp.transportStdio") : t("settings.mcp.transportHttp")}
							</button>
						))}
					</div>

					{form.transport === "stdio" ? (
						<>
							<Input
								size="sm"
								value={form.command}
								onChange={(e) => patch({ command: e.target.value })}
								placeholder={t("settings.mcp.commandPlaceholder") ?? ""}
								autoComplete="off"
							/>
							<Textarea
								className="min-h-14 font-mono"
								value={form.args}
								onChange={(e) => patch({ args: e.target.value })}
								placeholder={t("settings.mcp.argsPlaceholder") ?? ""}
								spellCheck={false}
							/>
							<Textarea
								className="min-h-14 font-mono"
								value={form.env}
								onChange={(e) => patch({ env: e.target.value })}
								placeholder={t("settings.mcp.envPlaceholder") ?? ""}
								spellCheck={false}
							/>
						</>
					) : (
						<>
							<Input
								size="sm"
								value={form.url}
								onChange={(e) => patch({ url: e.target.value })}
								placeholder={t("settings.mcp.urlPlaceholder") ?? ""}
								autoComplete="off"
							/>
							<Textarea
								className="min-h-14 font-mono"
								value={form.headers}
								onChange={(e) => patch({ headers: e.target.value })}
								placeholder={t("settings.mcp.headersPlaceholder") ?? ""}
								spellCheck={false}
							/>
						</>
					)}

					<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2">
						<Select
							value={form.lifecycle || "__default"}
							onValueChange={(value) => patch({ lifecycle: value === "__default" ? "" : value as FormState["lifecycle"] })}
						>
							<SelectTrigger className="w-full text-sm" aria-label={t("settings.mcp.lifecycleDefault")}><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectOption value="__default" label={t("settings.mcp.lifecycleDefault")} />
								<SelectOption value="eager" label={t("settings.mcp.lifecycleEager")} />
								<SelectOption value="keep-alive" label={t("settings.mcp.lifecycleKeepAlive")} />
								<SelectOption value="lazy-keep-alive" label={t("settings.mcp.lifecycleLazyKeepAlive")} />
							</SelectContent>
						</Select>
						<Select
							value={form.directTools || "__proxy"}
							onValueChange={(value) => patch({ directTools: value === "__proxy" ? "" : value as FormState["directTools"] })}
						>
							<SelectTrigger className="w-full text-sm" aria-label={t("settings.mcp.directProxy")}><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectOption value="__proxy" label={t("settings.mcp.directProxy")} />
								<SelectOption value="all" label={t("settings.mcp.directAll")} />
							</SelectContent>
						</Select>
					</div>
				</>
			)}

			{error ? <p className="text-xs text-[var(--inno-danger)]">{error}</p> : null}

			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<Button
					variant="primary"
					disabled={saving || !canSave}
					onClick={() => void handleSave()}
					className="shrink-0"
				>
					{saving ? t("common.loading") : t("common.save")}
				</Button>
				<Button
					variant="secondary"
					disabled={saving}
					onClick={onDone}
					className="shrink-0"
				>
					{t("common.cancel")}
				</Button>
			</div>
		</div>
	);
}

/* ---------- Server list ---------- */

const STATUS_COLORS: Record<McpServerRuntimeStatus, string> = {
	connected: "var(--inno-success)",
	cached: "var(--inno-accent)",
	failed: "var(--inno-danger)",
	"needs-auth": "var(--inno-warning)",
	"not-connected": "var(--inno-text-subtle)",
	disabled: "var(--inno-text-subtle)",
};

function serverSummary(view: McpServerView): string {
	const def = view.definition;
	if (def.url) return def.url;
	if (def.socket) return def.socket;
	return [def.command, ...(def.args ?? [])].filter(Boolean).join(" ");
}

function ServerRow({ view, onEdit }: { view: McpServerView; onEdit: () => void }) {
	const { t } = useTranslation();
	const disabled = view.definition.disabled === true;
	const runtimeStatus = disabled ? "disabled" : view.status?.status;
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [busy, setBusy] = useState(false);

	async function handleToggle(next: boolean) {
		setBusy(true);
		try {
			await mcpStore.setDisabled(view.name, !next);
		} catch {
			// error surfaced via store
		} finally {
			setBusy(false);
		}
	}

	async function handleDelete() {
		setBusy(true);
		try {
			await mcpStore.deleteServer(view.name);
		} catch {
			// error surfaced via store
		} finally {
			setBusy(false);
			setConfirmDelete(false);
		}
	}

	return (
		<div className="flex items-start justify-between gap-3 rounded-md border border-[var(--inno-border)] px-3 py-2.5">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					{runtimeStatus ? (
						<Tooltip label={t(`settings.mcp.status.${runtimeStatus}`)}>
							<span
								className="inline-block h-2 w-2 shrink-0 rounded-full"
								style={{ backgroundColor: STATUS_COLORS[runtimeStatus] }}
							/>
						</Tooltip>
					) : null}
					<span className="text-sm font-medium text-[var(--inno-text)]">{view.name}</span>
					<span className="rounded border border-[var(--inno-border)] px-1.5 py-0.5 text-xs uppercase text-[var(--inno-text-subtle)]">
						{view.transport}
					</span>
					{runtimeStatus ? (
						<span className="text-xs text-[var(--inno-text-muted)]">
							{t(`settings.mcp.status.${runtimeStatus}`)}
							{view.status && view.status.toolCount > 0 ? ` · ${t("settings.mcp.toolCount", { count: view.status.toolCount })}` : ""}
						</span>
					) : null}
				</div>
				<p className="mt-1 break-all text-xs leading-relaxed text-[var(--inno-text-subtle)]">{serverSummary(view)}</p>
				{!view.source.editable ? (
					<p className="mt-0.5 break-all text-xs text-[var(--inno-text-subtle)]">
						{t("settings.mcp.externalSource")}: {view.source.path}
					</p>
				) : null}
				{confirmDelete ? (
					<div className="mt-2 flex items-center gap-2">
						<span className="text-xs text-[var(--inno-danger)]">{t("settings.mcp.deleteConfirm", { name: view.name })}</span>
						<button
							disabled={busy}
							onClick={() => void handleDelete()}
							className="flex h-6 items-center rounded border border-[var(--inno-danger)] px-2 text-xs text-[var(--inno-danger)] hover:bg-[var(--inno-surface-muted)]"
						>
							{t("common.delete")}
						</button>
						<button
							disabled={busy}
							onClick={() => setConfirmDelete(false)}
							className="flex h-6 items-center rounded border border-[var(--inno-border)] px-2 text-xs text-[var(--inno-text-muted)] hover:text-[var(--inno-text)]"
						>
							{t("common.cancel")}
						</button>
					</div>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{view.source.editable ? (
					<>
						<IconButton
							size="xs"
							aria-label={t("common.edit")}
							title={t("common.edit")}
							onClick={onEdit}
						>
							<Pencil size={13} />
						</IconButton>
						<IconButton
							variant="danger"
							size="xs"
							aria-label={t("common.delete")}
							title={t("common.delete")}
							onClick={() => setConfirmDelete(true)}
						>
							<Trash2 size={13} />
						</IconButton>
						<Switch checked={!disabled} onChange={(v) => void handleToggle(v)} disabled={busy} aria-label={view.name} />
					</>
				) : null}
			</div>
		</div>
	);
}

function McpServersCard() {
	const { t } = useTranslation();
	const { overview, isLoading, error } = useStoreSnapshot(mcpStore, () => ({
		overview: mcpStore.overview,
		isLoading: mcpStore.isLoading,
		error: mcpStore.error,
	}));
	const [formOpen, setFormOpen] = useState<null | FormState>(null);

	useEffect(() => {
		void mcpStore.load();
	}, []);

	const servers = overview?.servers ?? [];

	return (
		<SettingsCard>
			<div className="mb-3 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h4 className="text-sm font-medium text-[var(--inno-text)]">{t("settings.mcp.serversTitle")}</h4>
					<p className="mt-1 break-all text-sm text-[var(--inno-text-muted)]">
						{t("settings.mcp.serversDesc")}
					</p>
					{overview ? (
						<p className="mt-1 break-all text-xs text-[var(--inno-text-subtle)]">{overview.configPath}</p>
					) : null}
				</div>
				<Button
					variant="primary"
					onClick={() => setFormOpen({ ...EMPTY_FORM })}
					className="shrink-0"
				>
					<Plus size={13} />
					{t("settings.mcp.addServer")}
				</Button>
			</div>

			{overview?.configError ? (
				<p className="mb-3 text-xs text-[var(--inno-danger)]">{t("settings.mcp.configError", { error: overview.configError })}</p>
			) : null}
			{error ? <p className="mb-3 text-xs text-[var(--inno-danger)]">{error}</p> : null}

			<div className="grid gap-2">
				{formOpen && !formOpen.name ? (
					<ServerForm initial={formOpen} onDone={() => setFormOpen(null)} />
				) : null}
				{servers.map((view) =>
					formOpen?.name === view.name ? (
						<ServerForm key={view.name} initial={formOpen} onDone={() => setFormOpen(null)} />
					) : (
						<ServerRow key={`${view.source.kind}:${view.name}`} view={view} onEdit={() => setFormOpen(formFromServer(view))} />
					),
				)}
				{!isLoading && servers.length === 0 && !formOpen ? (
					<p className="py-4 text-center text-xs text-[var(--inno-text-subtle)]">{t("settings.mcp.empty")}</p>
				) : null}
			</div>

			<p className="mt-3 text-xs leading-relaxed text-[var(--inno-text-subtle)]">{t("settings.mcp.footerHint")}</p>
		</SettingsCard>
	);
}

/* ---------- MCP category page ---------- */

export function McpSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	return (
		<SettingsSection title={t("settings.tabs.mcp")} description={t("settings.sections.mcp.desc")}>
			<McpMasterCard settings={settings} />
			{settings.mcp?.enabled === true ? <McpServersCard /> : null}
		</SettingsSection>
	);
}
