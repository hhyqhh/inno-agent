# Quickstart

5 分钟把 Inno Agent 跑起来。

## 1. 前置条件

- Node.js **>= 20.6.0**（`node -v` 检查）
- npm（随 Node 自带）
- 一个 LLM provider 的 API key
  - Anthropic / OpenAI / DeepSeek / 任意 OpenAI-compatible 端点 / Ollama 本地都可以

## 2. 安装

```bash
git clone <your-repo-url> inno-agent
cd inno-agent

npm install      # 会从 npm 拉 PI SDK，约 60s
npm run build    # 编译 backend + 前端，约 10s
```

## 3. 配置 API key

```bash
mkdir -p runtime/config runtime/data runtime/skills workspace
cp config.example.json runtime/config/config.json
```

编辑 `runtime/config/config.json`，把 `apiKey` 换成你自己的。下面三个例子任选一个：

**Anthropic 官方**

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "api": "anthropic-messages",
      "apiKey": "sk-ant-...",
      "models": [{ "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" }]
    }
  },
  "server": { "port": 3000 }
}
```

**OpenAI / DeepSeek（OpenAI-compatible）**

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-chat",
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "models": [{ "id": "deepseek-chat", "name": "DeepSeek Chat" }]
    }
  },
  "server": { "port": 3000 }
}
```

**InnoSpark（默认模板）**

直接用 `config.example.json` 的内容，把 `apiKey` 字段填上即可。

## 4. 启动

```bash
npm run server -- --home ./runtime --workspace ./workspace --port 3000
```

打开 **http://localhost:3000**。

## 5. 验证

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

在浏览器里发一条消息试试，比如 `"列出当前 workspace 里的文件"`。

---

## 其它常用命令

**CLI 模式**（终端里直接对话，不开 HTTP）：

```bash
npm run start -- --home ./runtime --workspace ./workspace
```

**开发模式**（前端 Vite HMR，需要两个终端）：

```bash
npm run dev:server     # 终端 1 — backend :3000
npm run web:dev        # 终端 2 — Vite :5173（代理 /api 到 :3000）
```

打开 **http://localhost:5173**。

**一键脚本**（封装了 build / start / stop / status / logs / smoke）：

```bash
./restart-dev.sh              # build + dev 模式起前后端
./restart-dev.sh --skip-build # 跳过编译直接重启
./restart-dev.sh status       # 看进程和健康状态
./restart-dev.sh logs server  # 跟 backend 日志
./restart-dev.sh smoke        # 跑一遍 health/session/WS 冒烟测试
./restart-dev.sh stop         # 停掉所有
./restart-dev.sh --help       # 全部选项
```

---

## 常见问题

**端口被占？** 加 `--port 3001`，或 `./restart-dev.sh --port 3001`。

**`apps/inno-agent/dist` 不存在？** 跑 `npm run build`。

**修改了 backend 代码不生效？** backend 跑的是编译后的 `dist/`，需要重新 `npm run build` 再重启。前端在 `web:dev` 下走 Vite HMR，改完直接刷新即可。

**想换 provider？** 改 `runtime/config/config.json` 的 `defaultProvider` 和 `defaultModel`，或者在 Web UI 顶部模型选择器里切——切换会自动写回 config 文件。

**如何生成会议纪要？** 在 `runtime/config/config.json` 的 `meeting` 配置中启用 Fun-ASR Realtime，并填写百炼工作空间的 WebSocket 地址和 API Key；语音凭据不会出现在前端设置中。重启服务后进入“笔记”，点击“会议录音”。结束录音后，逐字稿会持续保存在草稿中，并由当前文本模型自动整理摘要、决策和待办。浏览器需要麦克风权限，并通过 `https://` 或 `localhost` 访问。

**想看 backend 日志？** `tail -f runtime/logs/server.log`（用 `restart-dev.sh` 启动的话日志在这里）。

---

## 下一步

- 完整文档见 [README.md](./README.md)
- 自定义 skill：把 `<skill-name>.zip` 通过 Web UI 的 Skills 页面上传，或直接放进 `runtime/skills/<name>/`
- 配 Feishu / QQ / WeChat 渠道：编辑 `runtime/config/config.json` 的 `channels` 块
- 部署到生产：参考 README 的 Production Shape 一节，或用 `Dockerfile` / `docker-compose.yml`
