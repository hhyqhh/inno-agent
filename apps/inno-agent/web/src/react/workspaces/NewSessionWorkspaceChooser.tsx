import { useEffect, useMemo, useState } from "react";
import { useStoreSnapshot } from "../hooks.js";
import { sessionsStore } from "../../stores/sessions-store.js";
import { workspacesStore } from "../../stores/workspaces-store.js";
import type { WorkspaceMeta } from "../../api/workspaces.js";

type Mode = "temp" | "existing" | "new";

export function NewSessionWorkspaceChooser() {
	const workspaces = useStoreSnapshot(workspacesStore, () => ({
		list: workspacesStore.workspaces,
		isLoading: workspacesStore.isLoading,
	}));
	const sessions = useStoreSnapshot(sessionsStore, () => ({
		isLoading: sessionsStore.isLoading,
	}));

	const [mode, setMode] = useState<Mode>("temp");
	const [name, setName] = useState("");
	const [selectedId, setSelectedId] = useState<string>("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		if (workspaces.list.length === 0) {
			void workspacesStore.load();
		}
	}, []);

	const reusable = useMemo<WorkspaceMeta[]>(() => {
		return workspaces.list
			.filter((w) => !w.isTemp)
			.slice()
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	}, [workspaces.list]);

	useEffect(() => {
		if (mode === "existing" && !selectedId && reusable.length > 0) {
			setSelectedId(reusable[0].id);
		}
	}, [mode, reusable, selectedId]);

	const startBusy = submitting || sessions.isLoading;

	const handleSubmit = async () => {
		if (startBusy) return;
		setError("");
		setSubmitting(true);
		try {
			if (mode === "temp") {
				await sessionsStore.createSessionWith({ newWorkspace: { isTemp: true } });
			} else if (mode === "new") {
				const trimmed = name.trim();
				if (!trimmed) {
					setError("请填写工作区名称");
					return;
				}
				await sessionsStore.createSessionWith({ newWorkspace: { name: trimmed, isTemp: false } });
			} else if (mode === "existing") {
				if (!selectedId) {
					setError("请选择一个工作区");
					return;
				}
				await sessionsStore.createSessionWith({ workspaceId: selectedId });
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建会话失败");
		} finally {
			setSubmitting(false);
		}
	};

	const handleCancel = () => {
		sessionsStore.cancelPendingNewSession();
	};

	return (
		<div className="mx-auto mt-6 w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
			<h3 className="mb-1 text-sm font-semibold text-slate-900">为新对话选择工作区</h3>
			<p className="mb-4 text-xs text-slate-500">工作区是这次学习实践的文件目录,后续可以在右侧面板浏览、编辑、运行其中的文件。</p>

			<div className="grid grid-cols-3 gap-2">
				<ModeButton selected={mode === "temp"} onClick={() => setMode("temp")} title="临时工作区" subtitle="本次对话用完即弃" />
				<ModeButton selected={mode === "new"} onClick={() => setMode("new")} title="新建工作区" subtitle="给这次实践起个名字" />
				<ModeButton selected={mode === "existing"} onClick={() => setMode("existing")} title="使用已有" subtitle={`${reusable.length} 个可选`} disabled={reusable.length === 0} />
			</div>

			<div className="mt-4">
				{mode === "temp" ? (
					<p className="text-xs text-slate-500">将在 <code className="rounded bg-slate-100 px-1">.tmp/</code> 下创建临时目录,删除此对话时一并清理。</p>
				) : mode === "new" ? (
					<input
						type="text"
						placeholder="例如:pandas 数据统计 demo"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
						autoFocus
					/>
				) : (
					<select
						className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
						value={selectedId}
						onChange={(e) => setSelectedId(e.target.value)}
					>
						{reusable.length === 0 ? (
							<option value="">尚无可复用的工作区</option>
						) : (
							reusable.map((w) => (
								<option key={w.id} value={w.id}>
									{w.name}{w.id === "default" ? " (默认)" : ""}
								</option>
							))
						)}
					</select>
				)}
			</div>

			{error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}

			<div className="mt-5 flex items-center justify-end gap-2">
				<button
					type="button"
					onClick={handleCancel}
					className="rounded-md px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
					disabled={startBusy}
				>
					取消
				</button>
				<button
					type="button"
					onClick={handleSubmit}
					disabled={startBusy}
					className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
				>
					{startBusy ? "创建中…" : "开始对话"}
				</button>
			</div>
		</div>
	);
}

function ModeButton(props: { selected: boolean; onClick: () => void; title: string; subtitle: string; disabled?: boolean }) {
	const cls = props.selected
		? "border-blue-400 bg-blue-50 text-blue-900"
		: "border-slate-200 bg-white text-slate-700 hover:bg-slate-50";
	return (
		<button
			type="button"
			onClick={props.onClick}
			disabled={props.disabled}
			className={`rounded-lg border px-2.5 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
		>
			<div className="text-xs font-medium">{props.title}</div>
			<div className="mt-0.5 text-[10px] text-slate-500">{props.subtitle}</div>
		</button>
	);
}
