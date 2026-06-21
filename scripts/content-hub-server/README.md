# Content Hub — 本地 bundle 服务

一个**零依赖**的本地内容服务,实现 inno-agent 的 `contentHub` "bundle" 契约。
用它自托管技能库和工作区模板(预设),替代默认从 GitHub 拉取——适合私有部署。

## 它做什么

inno-agent 的内容源(`RemoteContentSource`)在 `type: "bundle"` 时会请求:

| 请求 | 返回 |
|---|---|
| `GET /index.json` | `{ "skills": [...], "presets": [...] }` 全量目录(带 meta) |
| `GET /skills/<name>.tar.gz` | `skill-library/<name>/` 的 gzip tar |
| `GET /presets/<name>.tar.gz` | `workspace-templates/<name>/` 的 gzip tar |

相比逐文件抓取,一次请求拿全量、无 GitHub 限流,鉴权也简单。

## 内容目录布局

服务扫描一个内容目录(默认 `./content`,相对启动时的工作目录):

```
content/
├── skill-library/
│   └── <skill-id>/
│       └── SKILL.md            # 顶部 frontmatter 的 description 进 index
└── workspace-templates/
    └── <preset-id>/
        ├── preset.json         # { id, name, description, icon } —— id 必须 == 目录名
        ├── agent.md
        └── .skills/<name>/SKILL.md
```

约定:`id` 用 `kebab-case`;以 `_` / `.` 开头的目录(如 `_template`)不进 index,适合放骨架。

> 把这个内容目录指向你**私有 git 仓库的工作副本**即可:仓库管内容,服务管打包分发。
> 一个简单的部署方式是:cron / git hook 里 `git pull`,服务实时按需打 tarball,无需重启。

## 启动

需要 Node >= 20 和系统 `tar`(macOS / Linux / Win10+ 自带)。

```bash
# 默认:服务 ./content,监听 :8787
node scripts/content-hub-server/server.mjs

# 指定内容目录和端口
CONTENT_DIR=/path/to/content PORT=9000 node scripts/content-hub-server/server.mjs

# 开启 Bearer token 鉴权(私有部署建议开)
HUB_TOKEN=your-secret node scripts/content-hub-server/server.mjs
```

仓库自带一个 `content-example/` 可直接试跑:

```bash
CONTENT_DIR=scripts/content-hub-server/content-example node scripts/content-hub-server/server.mjs
curl -s localhost:8787/index.json | python3 -m json.tool
curl -s localhost:8787/presets/demo-template.tar.gz -o /tmp/demo.tar.gz && tar -tzf /tmp/demo.tar.gz
```

## 在 inno-agent 里指向它

App 设置 →「内容源」→ 选「自托管服务」,填:

- **baseUrl**: `http://localhost:8787`(或你的部署地址)
- **token**: 若启用了 `HUB_TOKEN` 则填同样的值,否则留空

保存后,技能库和简单模式预设卡片都会从这个服务拉取。

> 也可直接写进 `runtime/config/config.json`:
> ```json
> {
>   "contentHub": {
>     "type": "bundle",
>     "baseUrl": "http://localhost:8787",
>     "token": ""
>   }
> }
> ```
