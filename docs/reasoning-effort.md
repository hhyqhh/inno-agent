# Optional reasoning effort

In Settings → Models → Add or Edit → Advanced, the existing **Supports reasoning** flag is unchanged. **Reasoning effort (optional)** adds a manual per-model preference. It is disabled unless Supports reasoning is checked.

- **Default** leaves the existing session and background-task behavior unchanged. It does not mean the request omits all reasoning parameters: the SDK or provider may supply a default.
- The listed values are configuration choices, **not detected capabilities**. A model-list endpoint generally returns IDs, not the full set of supported effort values. Model, provider, API type, and gateway behavior determine what is accepted.
- Some models have fixed or automatic reasoning, accept only a subset of levels, or cannot disable reasoning. Leave Default selected if the provider does not document an effort control. Do not use the list as evidence that every value is supported.
- An explicit selection applies to chats (including restored sessions), and L2 knowledge-base analysis, page generation, merging, link planning, and overview generation. SDK adapters translate the preference for the selected API. Increasing effort may increase latency and token usage. An unsupported value can still produce an API error.

For a gateway reporting `reasoning.effort: none is not supported`, select a value that its error or documentation explicitly accepts, such as **Low** or **Medium**. The application does not guess a universal default from a model's name or silently retry a paid request at a different effort.

The configuration field is optional:

```json
{
  "id": "gpt-6.1-sol",
  "name": "gpt-6.1-sol",
  "reasoning": true,
  "thinkingLevel": "low",
  "input": ["text", "image"],
  "contextWindow": 400000,
  "maxTokens": 8192
}
```

Accepted configuration values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. `off` maps to the adapter's disabled-reasoning behavior (for OpenAI Responses, typically `none`). Delete `thinkingLevel`, or select Default in the UI, to remove the override. With no override, a restored chat may retain the effort already saved in its transcript.

## 中文说明

设置 → 模型 → 新增或编辑 → 高级选项中，保留原有“支持推理”开关，增加“推理强度（可选）”。列表仅供手动配置，不代表已检测到模型能力。可用值由模型、服务商和 API 类型共同决定；中转服务也可能有额外限制。部分模型不支持调节强度，或不允许关闭推理。

“默认”保留原有聊天与后台任务行为，不保证请求完全不带推理参数。手动选择后，聊天和知识库调用都会应用该设置。请按服务商说明选择；较高强度可能增加耗时与用量，不支持的值仍可能导致接口报错。对于明确拒绝 `none` 的接口，可选择它实际支持的 `low` 或 `medium`。
