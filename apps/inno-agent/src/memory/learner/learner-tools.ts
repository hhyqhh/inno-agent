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

const BoundarySchema = Type.Object({
	stage: Type.Optional(Type.String({ description: "当前阶段，如“高中二年级”，用于确定解释深度" })),
	subjects: Type.Optional(Type.Array(Type.String(), { description: "主要课程，如 [\"数学\", \"物理\"]，限定学科范围" })),
	knowledge_scope: Type.Optional(Type.String({ description: "知识范围，如“人教A版必修一至选择性必修二”，防止调用未学内容" })),
	default_difficulty: Type.Optional(StringEnum(["school_exam", "foundation", "advanced", "competition"] as const, { description: "默认难度" })),
	beyond_scope_strategy: Type.Optional(StringEnum(["prompt_first", "allowed", "forbidden"] as const, { description: "超纲内容策略" })),
	method_constraint: Type.Optional(StringEnum(["textbook_first", "textbook_only", "unrestricted"] as const, { description: "解题方法约束" })),
	notation_standard: Type.Optional(Type.String({ description: "符号规范，如“采用课本常用符号”" })),
	reference_materials: Type.Optional(Type.String({ description: "参考资料，作为默认知识依据" })),
	warn_before_beyond_scope: Type.Optional(Type.Boolean({ description: "使用超纲知识前先提醒" })),
	annotate_knowledge_scope: Type.Optional(Type.Boolean({ description: "解题时标注使用的知识范围" })),
});

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Create the L1 learner tools.
 * The dataDir and learnerId are captured in closure. When `isEnabled` is
 * provided and returns false, every tool short-circuits to a disabled notice
 * so the profile is neither read nor mutated.
 */
export function createLearnerTools(
	dataDir: string,
	learnerId: string,
	isEnabled?: () => boolean,
): ToolDefinition[] {
	const L1_DISABLED_TEXT = "L1 学习者画像已在设置中关闭，当前不读取也不更新学习者画像。";
	const disabledResult = () => ({
		content: [{ type: "text" as const, text: L1_DISABLED_TEXT }],
		details: { disabled: true } as Record<string, unknown>,
	});

	const getLearnerContextTool = defineTool({
		name: "get_learner_context",
		label: "Get Learner Context",
		description:
			"读取当前学习者上下文包，包含活跃目标、相关概念掌握度、活跃误区和教学提示。在开始新对话或需要了解学习者状态时调用。",
		parameters: Type.Object({}),
		async execute() {
			if (isEnabled && !isEnabled()) return disabledResult();
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
					misconception_candidates: Type.Optional(Type.Array(Type.String(), { description: "Observed learner misconceptions or error patterns, e.g. ['thinks Rust ownership means the variable is destroyed after borrow']" })),
					affect: Type.Optional(Type.String({ description: "Detected affect, e.g. frustrated, confident" })),
					preference_candidates: Type.Optional(Type.Array(Type.String(), { description: "Observed learner preferences, e.g. ['prefers code-first explanations', '避免长篇理论']" })),
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				if (isEnabled && !isEnabled()) return disabledResult();
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
				if (isEnabled && !isEnabled()) return disabledResult();
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
			"更新学习者画像的特定字段。可以更新目标、知识状态、误区、偏好、学习边界和画像摘要。数组字段按 ID 合并（已存在则替换，不存在则新增）。学习边界为整体替换。",
		parameters: Type.Object({
			goals: Type.Optional(Type.Array(LearningGoalSchema)),
			knowledge_states: Type.Optional(Type.Array(KnowledgeStateSchema)),
			misconceptions: Type.Optional(Type.Array(MisconceptionSchema)),
			preferences: Type.Optional(PreferencesSchema),
			boundary: Type.Optional(BoundarySchema),
			profile_summary: Type.Optional(Type.String({ description: "Updated profile summary text" })),
		}),
		async execute(_toolCallId, params) {
			try {
				if (isEnabled && !isEnabled()) return disabledResult();
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
			if (isEnabled && !isEnabled()) return disabledResult();
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
				`## 学习边界`,
				`- 当前阶段: ${profile.boundary.stage || "未设定"}`,
				`- 主要课程: ${profile.boundary.subjects.join("、") || "未设定"}`,
				`- 知识范围: ${profile.boundary.knowledge_scope || "未设定"}`,
				`- 默认难度: ${(({ school_exam: "校内考试水平", foundation: "基础", advanced: "拔高", competition: "竞赛" } as Record<string, string>)[profile.boundary.default_difficulty] ?? profile.boundary.default_difficulty) || "未设定"}`,
				`- 超纲策略: ${(({ prompt_first: "需提示后再使用", allowed: "可直接使用", forbidden: "完全禁止" } as Record<string, string>)[profile.boundary.beyond_scope_strategy] ?? profile.boundary.beyond_scope_strategy) || "未设定"}`,
				`- 解题方法: ${(({ textbook_first: "优先教材方法", textbook_only: "仅教材方法", unrestricted: "不限制" } as Record<string, string>)[profile.boundary.method_constraint] ?? profile.boundary.method_constraint) || "未设定"}`,
				`- 符号规范: ${profile.boundary.notation_standard || "未设定"}`,
				`- 参考资料: ${profile.boundary.reference_materials || "未设定"}`,
				`- 使用超纲前提醒: ${profile.boundary.warn_before_beyond_scope ? "是" : "否"}`,
				`- 解题标注知识范围: ${profile.boundary.annotate_knowledge_scope ? "是" : "否"}`,
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
