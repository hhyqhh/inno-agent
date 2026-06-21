# Content Hub — 本地资源服务器:配置与使用

一个**零依赖**的本地内容服务,让 inno-agent 从你自己的机器(而不是默认的公共 GitHub 仓库)拉取**技能库**和**工作区模板(预设)**。适合私有部署、离线使用、或想自己维护一套内容。

- 服务脚本:`scripts/content-hub-server/server.mjs`(Node ≥ 20,仅用内置模块 + 系统 `tar`)
- 自带样例:`scripts/content-hub-server/content-example/`(开箱即跑)

---

## 一图看懂

```
你的内容目录                      本地服务 (:8787)                inno-agent 后端 (:3000)
content/                          server.mjs                       contentHub.type = "bundle"
├── skill-library/<id>/SKILL.md   ──扫描──►  GET /index.json   ◄──  baseUrl = http://localhost:8787
└── workspace-templates/<id>/     ──打包──►  GET /…/<id>.tar.gz ◄──  简单模式预设卡片 / 技能库
    ├── preset.json
    ├── agent.md
    └── .skills/
```

---

## 三步配置

### ① 启动本地服务

```bash
cd <项目根目录>

# 用自带样例先跑通(推荐第一次这样做)
CONTENT_DIR=scripts/content-hub-server/content-example PORT=8787 \
  node scripts/content-hub-server/server.mjs
```

看到这两行就是起来了:

```
[hub] … serving …/content-example
[hub] … listening on http://localhost:8787
```

环境变量:

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONTENT_DIR` | `./content` | 内容目录(相对启动时的工作目录) |
| `PORT` | `8787` | 监听端口 |
| `HUB_TOKEN` | 空 | 设置后要求 `Authorization: Bearer <token>`,私有部署建议开 |

### ② 让 inno-agent 指向它

编辑 `runtime/config/config.json`,把 `contentHub` 改成:

```json
{
  "contentHub": {
    "type": "bundle",
    "baseUrl": "http://localhost:8787",
    "token": ""
  }
}
```

字段说明:

| 字段 | bundle 模式 | 说明 |
|---|---|---|
| `type` | `"bundle"` | 切到自托管服务(默认是 `"github"`) |
| `baseUrl` | **必填** | 服务地址,如 `http://localhost:8787` |
| `token` | 可选 | 仅当服务开了 `HUB_TOKEN` 时填,值要一致 |

> `owner`/`repo`/`ref`/`skillsPath`/`presetsPath` 这些是 github 模式的字段,bundle 模式下忽略,可保留以便随时切回。

也可以在 App 里改:**设置 →「内容源」→ 选「自托管服务」**,填 baseUrl/token。

### ③ 重启后端生效

> ⚠️ 改 `config.json` 后**必须重启后端**——它只在启动时读 config。
> (在 App「内容源」面板里改则即时生效,无需重启。)

```bash
bash restart-dev.sh restart --skip-build
```

验证整条链路通了:

```bash
# 后端 → 本地服务,应列出预设
curl -s localhost:3000/api/preset-library | python3 -m json.tool
# 应列出技能
curl -s localhost:3000/api/skill-library  | python3 -m json.tool
```

然后打开 App、开启简单模式,欢迎页就会显示这些预设卡片。

---

## 内容目录怎么放

服务扫描 `CONTENT_DIR` 下两个固定子目录:

```
content/
├── skill-library/
│   └── <skill-id>/
│       └── SKILL.md            # 必需。顶部 frontmatter 的 description 进 index
│       └── (其它文件/子目录)    # 随技能一起打包下发
└── workspace-templates/
    └── <preset-id>/
        ├── preset.json         # 必需。{ id, name, description, icon }
        ├── agent.md            # 工作区上下文(每次对话注入系统提示)
        └── .skills/            # 可选,工作区私有技能
            └── <name>/SKILL.md
```

**两条硬规则**(违反则该项被静默跳过):

1. `preset.json` 里的 `id` **必须等于目录名**。
   - 例:目录 `zhishidian/` → `preset.json` 里 `"id": "zhishidian"`。
   - 复制现成模板改时最容易忘改这里,导致卡片不显示。
2. 技能目录必须含 `SKILL.md`,预设目录必须含 `preset.json`(作为识别标记)。

约定:

- `id` 用小写连字符 `kebab-case`。
- 以 `_` 或 `.` 开头的目录(如 `_template`)**不会**被当作可用项,适合放骨架/草稿。

### `preset.json` 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识,必须 == 目录名 |
| `name` | ✅ | 显示名,出现在预设卡片标题 |
| `description` | | 一句话说明,显示在卡片副标题 |
| `icon` | | [lucide](https://lucide.dev/icons/) 图标名,如 `presentation` / `book-open` / `lightbulb` |

---

## 用你自己的内容

样例只是演示。要提供真实内容,把 `CONTENT_DIR` 指向你自己的目录即可。最实用的做法是**指向一个 git 仓库的工作副本**(仓库管内容,服务管打包):

```bash
# 例:把 inno-agent-hub 仓库 clone 下来直接当内容源
git clone git@github.com:Chloris-Blaxk/inno-agent-hub.git /path/to/hub
CONTENT_DIR=/path/to/hub node scripts/content-hub-server/server.mjs
```

> 该仓库本身就是 `skill-library/` + `workspace-templates/` 布局,可直接用。
> 服务每次请求都实时重建 index / 按需打 tarball,所以 `git pull` 后**无需重启**,刷新即生效。

部署到服务器时,可在 cron 或 git webhook 里 `git pull`,服务持续提供最新内容。

---

## 接口契约(供二次开发)

inno-agent 的 `BundleServiceSource` 只依赖三个只读接口:

| 请求 | 返回 |
|---|---|
| `GET /index.json` | `{ "skills": [...], "presets": [...] }`,每项含 `id`/`name`/`description`,preset 另有 `icon` |
| `GET /skills/<id>.tar.gz` | `skill-library/<id>/` 的 gzip tar(含顶层 `<id>/`,客户端 `--strip-components=1` 剥掉) |
| `GET /presets/<id>.tar.gz` | `workspace-templates/<id>/` 的 gzip tar(同上) |
| `GET /health` | `{ ok, contentDir }` 健康检查 |

`id` = 目录名(路由/下载用),`name` = 显示名(preset 取自 `preset.json`)。
开了 `HUB_TOKEN` 时,所有请求需带 `Authorization: Bearer <token>`,否则 401。

你完全可以用任意语言/框架实现这套接口替换本服务(例如对接私有 git 服务、对象存储等)。

---

## 切回公共 GitHub 源

把 `config.json` 的 `contentHub.type` 改回 `"github"`,重启后端即可。
其余 github 字段(owner/repo/ref/...)我都保留着。注意:若需要私有仓库或更高 API 限额,要在 `token` 填一个 GitHub PAT。

---

## 排查

| 现象 | 原因 / 处理 |
|---|---|
| 预设卡片不显示某个模板 | 多半是 `preset.json` 的 `id` ≠ 目录名;或目录以 `_`/`.` 开头 |
| `/api/preset-library` 返回空 | 服务没起 / `baseUrl` 写错 / 后端没重启 |
| 改了 config 不生效 | 后端只在启动读 config,需 `restart-dev.sh restart --skip-build`(或用 App 面板改) |
| 401 Unauthorized | 服务开了 `HUB_TOKEN` 但 config 里 `token` 没填或不一致 |
| 下载的 tarball 多一层目录 | 客户端用 `tar --strip-components=1` 解包;手动验证时也要加这个参数 |

快速自检:

```bash
curl -s localhost:8787/health
curl -s localhost:8787/index.json | python3 -m json.tool
```
