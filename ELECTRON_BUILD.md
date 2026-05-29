# inno-agent Electron 打包说明

## 项目准备

```bash
npm install
npm run build
```

编译 TypeScript 后端 + Vite 构建前端，确认可以正常 build 后再打包。

## electron/ 目录

| 文件 | 用途 |
|------|------|
| `main.js` | Electron 主进程：启动后端、托盘、窗口 |
| `loading.html` | 服务启动期间的 loading 页 |

首次启动会在 `~/.inno-agent/config/config.json` 写入默认配置（API Key 为空）；用户在应用内设置页填写即可。

## electron/main.js 要点

- `use-mock-keychain`：未签名 app 避免 macOS 钥匙串弹窗
- `ELECTRON_RUN_AS_NODE=1` + `spawn(process.execPath, [server.js])`：用 Electron 内置 Node 跑后端，正确解析 asar 内 `node_modules`
- 轮询 `http://localhost:3000/health`，就绪后关闭 loading 窗口并打开主界面

## 本地打包

```bash
./scripts/build-mac.sh
# 或
npm run electron:build
```

产物：`dist-electron/Inno Agent-<version>-arm64.dmg`

## CI 发版

推送版本 tag 触发 GitHub Actions（见 `.github/workflows/release-mac.yml`）：

```bash
git tag v0.3.0 && git push origin v0.3.0
```

## 注意事项

App 未经代码签名时，用户首次打开需 **右键 → 打开** 绕过 Gatekeeper。正式分发需 Apple Developer 账号签名与公证（workflow 内已预留注释配置项）。
