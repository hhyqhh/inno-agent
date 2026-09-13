# 权限与沙箱(Permissions & Sandbox)

Inno Agent 有两道相互独立的防线控制 agent 的工具执行。**权限层**决定"要不要问你",**沙箱层**决定"物理上能不能做"。两者可以单独开，也可以叠用。

| | 权限层(pi-permission-system) | 沙箱层(pi-sandbox) |
|---|---|---|
| 本质 | 策略网关:allow / ask / deny | OS 级强制:sandbox-exec (macOS) / bubblewrap (Linux) |
| 拦截方式 | 工具调用前裁决;ask 时弹审批卡片 | 命令在受限子进程里执行,越界由内核拒绝(EPERM) |
| 覆盖范围 | 所有工具(bash、读写、MCP、技能等) | bash 子进程的文件系统与网络;read/write/edit 工具走插件内置的路径策略 |
| 默认状态 | 开启(`plugins.permissionSystem.enabled`) | 关闭,需 `--sandbox` 启动 |
| 配置文件 | `<configDir>/extensions/pi-permission-system/config.json` | `<configDir>/sandbox.json`(全局)、`<workspace>/.pi/sandbox.json`(项目级) |

关键性质:**permission 放行 ≠ sandbox 放行**。审批卡片通过后,命令仍会被沙箱按 `allowRead/allowWrite/allowedDomains` 约束;反过来 sandbox 不管"要不要问",只管"能不能做"。

## 权限层

### 三档模式

输入框工具栏的盾牌按钮(🛡)随聊随切,立即生效、无需重启;档位持久化在主配置 `config.json` 的 `plugins.permissionSystem.mode`:

| 档位 | 值 | 行为 |
|---|---|---|
| 默认权限(默认) | `default` | 只读白名单外的 bash 命令弹审批卡片 |
| 自动审批 | `auto` | bash 不再弹卡(规则表 `"*": "allow"`) |
| 完全权限 | `yolo` | 所有表面免询问(插件 `yoloMode: true`) |

**deny 底线在任何档位都生效**:`sudo *`、`rm -rf /`、`rm -rf ~`、`mkfs *`、`dd *`、`shutdown`、`reboot`,以及 `~/.ssh/*`、`~/.aws/*`、`*.env`、`*.pem`、`*.key` 等敏感路径,始终直接拒绝且不弹卡。yoloMode 只把 ask 改写成 allow,改不了 deny。

**自动审批与完全权限的差别**在于插件的防绕过机制:命令解析后"看不透"的写法(`eval …`、`bash -c "…"`、`xargs`、`find -exec`、解析失败的复杂命令)即使命中 allow 也会被降级为合成 ask(`<opaque-bash-wrapper>` 等)——自动审批档下这些仍会弹卡,完全权限档下也被放行。

### 审批卡片

ask 命中的命令在 web UI 弹出审批卡片,三个选项:

- **仅此次**(`allow_once`):只放行这一次
- **本会话允许**(`allow_session`):同一命令模式进程内缓存,不再弹卡;重启后重新询问
- **拒绝**(`deny`):拒绝并带教学性说明返回给 agent

无头场景(定时任务、IM 渠道、非流式 API)没有卡片可弹,ask 一律 fail-closed 拒绝——要让它跑通,只能把对应命令加进 allow 规则或切换到自动审批档。

### 规则配置细节

托管默认策略(首次运行时写入,之后不覆盖;在 UI 切换档位会按模板重写,手改会丢):

```jsonc
{
  "yoloMode": false,
  "authorizerChain": ["inno-web"],   // web 审批卡片的应答链路,勿删
  "permission": {
    "*": "allow",                     // inno 自有工具(记忆/调度/wiki 等)不打扰
    "bash": {
      "*": "ask",                     // 默认档;自动审批档为 "allow"
      "ls": "allow", "cat *": "allow", "git status": "allow", /* …只读白名单 */
      "sudo *": "deny",               // 危险命令硬拒,可带 reason 字段
      "rm -rf ~": { "action": "deny", "reason": "Refusing to delete the home directory." }
    },
    "path": {
      "*": "allow",
      "~/.ssh/*": "deny", "*.env": "deny", "*.pem": "deny" /* …敏感路径 */
    },
    "external_directory": "allow"     // 该表面的 ask 无法从 web 批准,故不产生 ask
  }
}
```

规则匹配**最具体者胜出**,deny 优先于 ask 优先于 allow。想给常用命令免卡,在 `bash` 里加一行 `"npm *": "allow"` 即可,改文件后下次会话切换自动重载(插件在 `session_start`/`resources_discover` 时重读)。

## 沙箱层

用 `--sandbox` 启动(`npm run server:sandbox`)后:

- **bash 命令**被 `sandbox-exec`(macOS)/ `bubblewrap`(Linux)包裹执行,文件系统与网络按配置约束,越界报 `Operation not permitted`
- **read/write/edit 工具**由插件在 Node 层做同样的路径策略(这些工具不走子进程,OS 沙箱管不到)
- 越界时 TUI 会弹交互提示;**server 模式是无头的,提示自动视为 abort**——即拦截即拒绝,无卡片

### 默认配置

无 `sandbox.json` 时的内置默认:

```jsonc
{
  "enabled": true,
  "network": {
    "allowedDomains": [
      "npmjs.org", "registry.npmjs.org", "registry.yarnpkg.com",
      "pypi.org", "github.com", "api.github.com", "raw.githubusercontent.com"
      /* 包管理与 GitHub;其余域名出网被代理拦截 */
    ]
  },
  "filesystem": {
    "denyRead": ["/Users", "/home"],                       // 先大面拒绝
    "allowRead": [".", "~/.config", "~/.local", "Library"], // 再开工作区等小口
    "allowWrite": [".", "/tmp"],                           // "." = 工作区目录
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

读规则:`allowRead` 可以在 `denyRead` 里打洞;写规则相反,`denyWrite` 永远优先。项目级 `<workspace>/.pi/sandbox.json` 与全局合并,项目级优先。

已知怪癖:macOS 上 `/tmp` 是 `/private/tmp` 的软链,sandbox-exec 按真实路径匹配,所以默认配置里写 `/tmp` 实际放不进 `/tmp`——需要写 `/private/tmp`。

## 推荐组合

| 场景 | 权限档 | 沙箱 | 效果 |
|---|---|---|---|
| 日常学习使用 | 默认权限 | 关 | 关键操作有卡片把关 |
| 嫌卡片烦 | 自动审批 | **开** | 不弹卡,但命令物理上出不了工作区 |
| 定时任务/IM 渠道(无人看卡) | 自动审批或完全权限 | **开** | 无头可跑,越界仍被内核拒绝 |
| 完全信任的全自动 | 完全权限 | 开 | 无任何询问,deny 底线 + 沙箱双兜底 |

一句话:**卡片交给 permission,底线交给 deny 规则和 sandbox**。
