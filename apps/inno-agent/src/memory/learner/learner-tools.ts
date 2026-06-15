import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadProfile } from "./profile-store.js";
import { recordEventAndUpdateProfile } from "./profile-store.js";
import { buildContextPack } from "./context-pack.js";
import { patchProfile, updateProfile } from "./profile-updater.js";
import { createLearningEvent } from "./types.js";
import { logger } from "../../logger.js";

// ============================================================================
// TypeBox Schemas for complex types
// ============================================================================

const LearningGoalSchema = Type.Object({
	goal_id: Type.String({ description: "Unique goal identifier" }),
	title: Type.String({ description: "Goal title" }),
	type: StringEnum(["skill", "concept", "project", "exam", "habit"] as const),
	priority: Type.Number({ description: "Priority 0-1, higher is more important", minimum: 0, maximum: 1 }),
	status: StringEnum(["active", "paused", "completed", "archived"] as const),
	success_criteria: Type.Array(Type.String(), { description: "Measurable success criteria" }),
	source: StringEnum(["user_declared", "agent_inferred", "imported"] as const),
	updated_at: Type.String({ description: "ISO 8601 timestamp" }),
});

const KnowledgeStateSchema = Type.Object({
	concept_id: Type.String({ description: "Unique concept identifier, e.g. python.list_comprehension" }),
	concept_name: Type.String({ description: "Human-readable concept name" }),
	domain: Type.String({ description: "Knowledge domain, e.g. programming.python" }),
	mastery: Type.Number({ description: "Mastery level 0-1", minimum: 0, maximum: 1 }),
	confidence: Type.Number({ description: "Confidence in mastery estimate 0-1", minimum: 0, maximum: 1 }),
	stability: Type.Number({ description: "Knowledge stability 0-1", minimum: 0, maximum: 1 }),
	last_practiced_at: Type.Optional(Type.String({ description: "ISO 8601 timestamp" })),
	review_due_at: Type.Optional(Type.String({ description: "ISO 8601 timestamp for next review" })),
	evidence_ids: Type.Array(Type.String(), { description: "IDs of supporting learning events" }),
	diagnosis: Type.String({ description: "Current diagnosis of learner state on this concept" }),
	next_actions: Type.Array(Type.String(), { description: "Recommended next learning actions" }),
});

const MisconceptionSchema = Type.Object({
	misconception_id: Type.String({ description: "Unique misconception identifier" }),
	concept_id: Type.String({ description: "Related concept ID" }),
	description: Type.String({ description: "Description of the misconception" }),
	status: StringEnum(["active", "repairing", "resolved", "stale"] as const),
	severity: Type.Number({ description: "Severity 0-1", minimum: 0, maximum: 1 }),
	confidence: Type.Number({ description: "Confidence in this diagnosis 0-1", minimum: 0, maximum: 1 }),
	first_seen_at: Type.String({ description: "ISO 8601 timestamp" }),
	last_seen_at: Type.String({ description: "ISO 8601 timestamp" }),
	evidence_ids: Type.Array(Type.String(), { description: "IDs of supporting learning events" }),
	repair_strategy: Type.String({ description: "Strategy to fix this misconception" }),
});

const PreferencesSchema = Type.Object({
	explanation_style: Type.Optional(Type.Array(Type.String(), { description: "e.g. example_first, code_first, theory_first" })),
	practice_style: Type.Optional(Type.Array(Type.String(), { description: "e.g. small_steps, immediate_feedback" })),
	feedback_tone: Type.Optional(Type.Array(Type.String(), { description: "e.g. direct, encouraging, socratic" })),
	avoid: Type.Optional(Type.Array(Type.String(), { description: "Things to avoid in teaching" })),
});

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Create the four L1 learner tools.
 * The dataDir and learnerId are captured in closure.
 */
export function createLearnerTools(dataDir: string, learnerId: string): ToolDefinition[] {
	const getLearnerContextTool = defineTool({
		name: "get_learner_context",
		label: "Get Learner Context",
		description:
			"读取当前学习者上下文包，包含活跃目标、相关概念掌握度、活跃误区和教学提示。在开始新对话或需要了解学习者状态时调用。",
		parameters: Type.Object({}),
		async execute() {
			const profile = loadProfile(dataDir);
			const pack = buildContextPack(profile);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(pack, null, 2) }],
				details: {},
			};
		},
	});

	const recordLearningEventTool = defineTool({
		name: "record_learning_event",
		label: "Record Learning Event",
		description:
			"记录一个结构化的学习事件，并自动把确定性信号合入 L1 学习者画像。当观察到学习者声明/停止/切换目标、完成练习、接受讲解、自我评估、表达偏好、接收反馈或达到里程碑时调用。",
		parameters: Type.Object({
			event_type: StringEnum([
				"goal_declared",
				"exercise_attempt",
				"concept_explained",
				"self_assessed",
				"preference_stated",
				"feedback_received",
				"milestone_reached",
			] as const, { description: "Type of learning event" }),
			context: Type.Object({
				goal_id: Type.Optional(Type.String({ description: "Related goal ID" })),
				concept_ids: Type.Optional(Type.Array(Type.String(), { description: "Related concept IDs" })),
				session_id: Type.Optional(Type.String({ description: "Current session ID" })),
			}),
				payload: Type.Record(Type.String(), Type.Unknown(), {
					description:
						"Event-specific data. For stopping a goal, include goal_description/action/reason such as { goal_description: '不再学习 Rust', action: 'archived' }. For switching goals, include previous_goal and goal.",
				}),
			derived_signals: Type.Optional(
				Type.Object({
					mastery_delta: Type.Optional(Type.Number({ description: "Change in mastery estimate" })),
					misconception_candidates: Type.Optional(Type.Array(Type.String())),
					affect: Type.Optional(Type.String({ description: "Detected affect, e.g. frustrated, confident" })),
					preference_candidates: Type.Optional(Type.Array(Type.String())),
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const event = createLearningEvent(
					learnerId,
					params.event_type,
					params.context,
					params.payload as Record<string, unknown>,
					params.derived_signals,
				);
				const profile = recordEventAndUpdateProfile(dataDir, event);
				return {
					content: [
						{
							type: "text" as const,
							text: `学习事件已记录并同步画像: ${event.event_id} (${event.event_type})，当前画像版本 ${profile.version}`,
						},
					],
					details: { event_id: event.event_id, profile_version: profile.version },
				};
			} catch (err) {
				logger.warn({ err, params }, "record_learning_event tool failed");
				throw err;
			}
		},
		});

	const patchLearnerProfileTool = defineTool({
		name: "patch_learner_profile",
		label: "Patch Learner Profile",
		description:
			"低成本局部更新 L1 学习者画像。用于在一次学习互动后调整某个概念的掌握度/诊断/复习时间，追加偏好或画像摘要；不需要提交完整知识状态对象。",
		parameters: Type.Object({
			concept_id: Type.Optional(Type.String({ description: "Concept ID to create or patch, e.g. rust.ownership" })),
			concept_name: Type.Optional(Type.String({ description: "Human-readable concept name" })),
			domain: Type.Optional(Type.String({ description: "Knowledge domain, e.g. programming.rust" })),
			mastery_delta: Type.Optional(Type.Number({ description: "Small mastery adjustment, e.g. 0.03 or -0.02" })),
			mastery: Type.Optional(Type.Number({ description: "Absolute mastery 0-1", minimum: 0, maximum: 1 })),
			confidence: Type.Optional(Type.Number({ description: "Confidence 0-1", minimum: 0, maximum: 1 })),
			stability_delta: Type.Optional(Type.Number({ description: "Knowledge stability adjustment" })),
			diagnosis: Type.Optional(Type.String({ description: "Updated diagnosis for this concept" })),
			next_actions_append: Type.Optional(Type.Array(Type.String(), { description: "Next actions to append" })),
			evidence_ids_append: Type.Optional(Type.Array(Type.String(), { description: "Supporting event IDs to append" })),
			last_practiced_at: Type.Optional(Type.String({ description: "ISO 8601 timestamp" })),
			review_due_at: Type.Optional(Type.String({ description: "ISO 8601 timestamp" })),
			preferences_append: Type.Optional(PreferencesSchema),
			profile_summary_append: Type.Optional(Type.String({ description: "One concise sentence to append to profile summary" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const updated = patchProfile(dataDir, params);
				return {
					content: [
						{
							type: "text" as const,
							text: `学习者画像已局部更新至版本 ${updated.version}`,
						},
					],
					details: { version: updated.version },
				};
			} catch (err) {
				logger.warn({ err, params }, "patch_learner_profile tool failed");
				throw err;
			}
		},
	});

	const updateLearnerProfileTool = defineTool({
		name: "update_learner_profile",
		label: "Update Learner Profile",
		description:
			"更新学习者画像的特定字段。可以更新目标、知识状态、误区、偏好和画像摘要。数组字段按 ID 合并（已存在则替换，不存在则新增）。",
		parameters: Type.Object({
			goals: Type.Optional(Type.Array(LearningGoalSchema)),
			knowledge_states: Type.Optional(Type.Array(KnowledgeStateSchema)),
			misconceptions: Type.Optional(Type.Array(MisconceptionSchema)),
			preferences: Type.Optional(PreferencesSchema),
			profile_summary: Type.Optional(Type.String({ description: "Updated profile summary text" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const updated = updateProfile(dataDir, params);
				return {
					content: [
						{
							type: "text" as const,
							text: `学习者画像已更新至版本 ${updated.version}`,
						},
					],
					details: { version: updated.version },
				};
			} catch (err) {
				logger.warn({ err, params }, "update_learner_profile tool failed");
				throw err;
			}
		},
	});

	const reviewLearnerProfileTool = defineTool({
		name: "review_learner_profile",
		label: "Review Learner Profile",
		description:
			"展示完整的学习者画像，供用户查看、修正或删除。当用户请求查看自己的学习状态时调用。",
		parameters: Type.Object({}),
		async execute() {
			const profile = loadProfile(dataDir);
			const summary = [
				`学习者 ID: ${profile.learner_id}`,
				`版本: ${profile.version}`,
				`更新时间: ${profile.updated_at}`,
				``,
				`## 学习目标 (${profile.goals.length})`,
				...profile.goals.map(
					(g) => `- [${g.status}] ${g.title} (优先级: ${g.priority}, 类型: ${g.type})`,
				),
				``,
				`## 知识状态 (${profile.knowledge_states.length})`,
				...profile.knowledge_states.map(
					(ks) =>
						`- ${ks.concept_name} (${ks.concept_id}): 掌握度 ${ks.mastery.toFixed(2)}, 置信度 ${ks.confidence.toFixed(2)}\n  诊断: ${ks.diagnosis}`,
				),
				``,
				`## 误区 (${profile.misconceptions.length})`,
				...profile.misconceptions.map(
					(m) => `- [${m.status}] ${m.description} (严重度: ${m.severity.toFixed(2)})`,
				),
				``,
				`## 偏好`,
				`- 讲解风格: ${profile.preferences.explanation_style.join(", ") || "未设定"}`,
				`- 练习风格: ${profile.preferences.practice_style.join(", ") || "未设定"}`,
				`- 反馈语气: ${profile.preferences.feedback_tone.join(", ") || "未设定"}`,
				`- 避免: ${profile.preferences.avoid.join(", ") || "未设定"}`,
				``,
				`## 画像摘要`,
				profile.profile_summary || "暂无摘要",
			];

			return {
				content: [{ type: "text" as const, text: summary.join("\n") }],
				details: {},
			};
		},
	});

	return [
		getLearnerContextTool,
		recordLearningEventTool,
		patchLearnerProfileTool,
		updateLearnerProfileTool,
		reviewLearnerProfileTool,
	];
}
