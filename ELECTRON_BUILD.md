# inno-agent Electron 说明

## 云端打包（发版）

见 **[`docs/mac-app-packaging.md`](docs/mac-app-packaging.md)**（GitHub Actions **macOS Release** 工作流）。

## electron/ 目录

| 文件 | 用途 |
|------|------|
| `main.js` | Electron 主进程：启动后端、托盘、窗口 |
| `loading.html` | 服务启动期间的 loading 页 |

首次启动会在 `~/.inno-agent/config/config.json` 写入默认配置（API Key 为空）；用户在应用内设置页填写即可。

## electron/main.js 要点

- `use-mock-keychain`：未签名 app 避免 macOS 钥匙串弹窗
- `ELECTRON_RUN_AS_NODE=1` + `spawn(process.execPath, [server.js])`：用 Electron 内置 Node 跑后端，正确解析 asar 内 `node_modules`
- 默认优先使用 3000 端口；若已被其他服务占用，则自动选择空闲端口。轮询实际端口的 `/health`，就绪后关闭 loading 窗口并打开主界面
