import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JobStore } from "./job-store.js";
import type { ScheduledJob } from "./types.js";
import type { ChannelRegistry } from "../channels/channel.js";
import { executeJob } from "./job-runner.js";
import { validateCron } from "./cron-utils.js";

/**
 * Create scheduler tools that allow the agent to manage scheduled jobs.
 * Works in both CLI and server contexts.
 */
export function createSchedulerTools(jobStore: JobStore, channelRegistry?: ChannelRegistry): ToolDefinition[] {
	const createJobTool = defineTool({
		name: "create_scheduled_job",
		label: "Create Scheduled Job",
		description:
			"创建一个定时任务。用户说「每天晚上9点提醒我复习」或「设置一个每周总结」时调用。cron 表达式示例：'0 21 * * *' 表示每天21:00，'0 9 * * 1' 表示每周一9:00。",
		parameters: Type.Object({
			name: Type.String({ description: "任务名称" }),
			cron: Type.String({ description: "Cron 表达式，如 '0 21 * * *'" }),
			taskType: StringEnum([
				"daily_review",
				"weekly_summary",
				"learner_profile_reflection",
				"spaced_review",
				"push_reminder",
				"custom_prompt",
			] as const, { description: "任务类型" }),
			prompt: Type.String({ description: "执行时发送给 agent 的提示词" }),
			channel: Type.Optional(StringEnum(["feishu", "qq", "wechat", "wecom"] as const, {
				description: "结果推送的频道（可选）",
			})),
			chatId: Type.Optional(Type.String({ description: "推送目标的 chat_id（可选）" })),
		}),
		async execute(_toolCallId, params) {
			const cronCheck = validateCron(params.cron);
			if (!cronCheck.ok) {
				return {
					content: [{
						type: "text" as const,
						text: `Cron 表达式不合法：${cronCheck.error}。请改用形如 '30 14 28 2 *' 的 5 段表达式后重试。`,
					}],
					details: { error: "invalid_cron" } as Record<string, unknown>,
				};
			}
			if (params.channel && !channelRegistry?.get(params.channel)) {
				return {
					content: [{
						type: "text" as const,
						text: `频道「${params.channel}」尚未注册（用户未启用该 channel）。请提示用户先在设置里启用并配置 ${params.channel}，或者把任务改为不指定 channel（仅站内提醒）。`,
					}],
					details: { error: "channel_not_registered", channel: params.channel } as Record<string, unknown>,
				};
			}
			const defaultTarget = params.channel ? channelRegistry?.getDefaultTarget(params.channel) : undefined;
			const job = jobStore.create({
				name: params.name,
				cron: params.cron,
				timezone: "Asia/Shanghai",
				enabled: true,
				taskType: params.taskType,
				prompt: params.prompt,
				channel: params.channel,
				target: params.channel && params.chatId
					? { channel: params.channel, chatId: params.chatId }
					: defaultTarget,
			});

			return {
				content: [{
					type: "text" as const,
					text: `定时任务已创建：${job.name} (${job.id})\nCron: ${job.cron}\n类型: ${job.taskType}\n下次执行: ${job.nextRunAt ?? "无法计算，请检查 cron 表达式"}\n\n你可以说「执行这个任务」来立即运行，或等待后台调度器自动触发。`,
				}],
				details: { jobId: job.id } as Record<string, unknown>,
			};
		},
	});

	const listJobsTool = defineTool({
		name: "list_scheduled_jobs",
		label: "List Scheduled Jobs",
		description: "列出所有定时任务。用户问「我有哪些定时任务」或「查看定时任务」时调用。",
		parameters: Type.Object({}),
		async execute() {
			const jobs = jobStore.list();
			if (jobs.length === 0) {
				return {
					content: [{ type: "text" as const, text: "当前没有定时任务。" }],
					details: {},
				};
			}

			const lines = jobs.map((j: ScheduledJob) =>
				`- [${j.enabled ? "启用" : "禁用"}] ${j.name} (${j.id})\n  Cron: ${j.cron} | 类型: ${j.taskType}\n  状态: ${j.lastStatus ?? "未运行"} | 成功/失败: ${Math.max(0, j.runCount - j.failureCount)}/${j.failureCount}\n  上次执行: ${j.lastRunAt ?? "从未"}\n  下次执行: ${j.nextRunAt ?? "未计算"}`,
			);

			return {
				content: [{ type: "text" as const, text: `定时任务列表 (${jobs.length})：\n\n${lines.join("\n\n")}` }],
				details: {},
			};
		},
	});

	const updateJobTool = defineTool({
		name: "update_scheduled_job",
		label: "Update Scheduled Job",
		description: "更新或禁用一个定时任务。可以修改名称、cron、启用状态、提示词等。",
		parameters: Type.Object({
			id: Type.String({ description: "任务 ID" }),
			name: Type.Optional(Type.String({ description: "新名称" })),
			cron: Type.Optional(Type.String({ description: "新 Cron 表达式" })),
			enabled: Type.Optional(Type.Boolean({ description: "是否启用" })),
			prompt: Type.Optional(Type.String({ description: "新提示词" })),
		}),
		async execute(_toolCallId, params) {
			const { id, ...patch } = params;
			if (patch.cron !== undefined) {
				const cronCheck = validateCron(patch.cron);
				if (!cronCheck.ok) {
					return {
						content: [{
							type: "text" as const,
							text: `Cron 表达式不合法：${cronCheck.error}。任务未更新。`,
						}],
						details: { error: "invalid_cron" } as Record<string, unknown>,
					};
				}
			}
			const updated = jobStore.update(id, patch);
			if (!updated) {
				return {
					content: [{ type: "text" as const, text: `未找到任务 ${id}` }],
					details: {} as Record<string, unknown>,
				};
			}
			return {
				content: [{ type: "text" as const, text: `任务 ${updated.name} (${updated.id}) 已更新。` }],
				details: {} as Record<string, unknown>,
			};
		},
	});

	const deleteJobTool = defineTool({
		name: "delete_scheduled_job",
		label: "Delete Scheduled Job",
		description: "删除一个定时任务。",
		parameters: Type.Object({
			id: Type.String({ description: "要删除的任务 ID" }),
		}),
		async execute(_toolCallId, params) {
			const deleted = jobStore.delete(params.id);
			return {
				content: [{
					type: "text" as const,
					text: deleted ? `任务 ${params.id} 已删除。` : `未找到任务 ${params.id}`,
				}],
				details: {},
			};
		},
	});

	const runJobTool = defineTool({
		name: "run_scheduled_job",
		label: "Run Scheduled Job",
		description:
			"立即执行一个定时任务。当用户说「执行那个复习任务」或「现在就运行每日总结」时调用。执行 job 中定义的 prompt 并返回结果。",
		parameters: Type.Object({
			id: Type.String({ description: "要执行的任务 ID" }),
		}),
		async execute(_toolCallId, params) {
			const job = jobStore.get(params.id);
			if (!job) {
				return {
					content: [{ type: "text" as const, text: `未找到任务 ${params.id}` }],
					details: {},
				};
			}
			if (!channelRegistry) {
				return {
					content: [{
						type: "text" as const,
						text: "当前运行环境没有可用的后台 ChannelRegistry，无法真正执行任务。",
					}],
					details: {},
				};
			}

			const result = await executeJob(job, jobStore, channelRegistry, "manual");
			return {
				content: [{
					type: "text" as const,
					text: result.success
						? `任务「${job.name}」已执行完成。\nRun: ${result.runId}\n${result.pushedToChannel ? `已推送到: ${result.pushedToChannel}\n` : ""}\n输出：\n${result.output ?? ""}`
						: `任务「${job.name}」执行失败。\nRun: ${result.runId}\n错误：${result.error}`,
				}],
				details: result,
			};
		},
	});

	return [createJobTool, listJobsTool, updateJobTool, deleteJobTool, runJobTool];
}
