# macOS 签名与公证发布

## 已配置的签名身份

- Developer ID Application: Hao Hao (Q5N3RF9WVC)
- Team ID：`Q5N3RF9WVC`
- 本机证书路径：`<repo>/runtime/inno-agent-developer-id.p12`（原 `$HOME/Documents/` 位置受 macOS TCC 保护，终端/CI 脚本读不到，已迁至 gitignored 的 runtime/）
- 本机默认 Apple ID：`hhyqhh@126.com`（可用环境变量 `APPLE_ID` 覆盖）

`.p12` 包含私钥，不能提交 Git、作为 Release 附件，或发送到聊天中。
证书安装/文件存在不代表已验证密码或完成应用签名。当前证书到期时间为
2027-02-02 06:12:15（北京时间），到期前需更新本机证书和 CI Secret。

## 本机打包

先安装依赖（`npm ci`），确保 Xcode 命令行工具中的 `notarytool`、`stapler` 可用。
在 Apple Account 的“登录与安全”中生成 **App 专用密码**；它不是 Apple 登录密码。
然后在自己的终端运行：

```bash
npm run electron:build:mac:signed
```

脚本默认读取上述 `.p12`，依次隐藏输入导出密码和 Apple App 专用密码。
密码仅供本次进程使用，不写入文件或 shell 历史。不要用 `bash -x`、调试日志或录屏运行。
也可事先通过安全方式提供同名环境变量。首次签名时如 macOS 弹出私钥访问提示，
请确认是本次构建的签名操作后由本人授权。

此命令会解密检查 `.p12`、编译前后端、签名应用、将应用提交 Apple 公证、
staple 公证票据、生成 arm64 DMG，再只读挂载 DMG 验证内部应用：

- `codesign` 深度/严格校验及预期 Team ID；
- Hardened Runtime；
- `stapler validate`；
- Gatekeeper `spctl --assess`。

完成产物：`dist-electron/inno-agent-<版本>-arm64.dmg`。
需另外人工测试安装、首次启动、内置终端和后端功能；静态校验不能代替运行测试。
当前仅构建 Apple Silicon（arm64），未新增 Intel 版本。

## GitHub Actions

目标仓库：`hhyqhh/inno-agent`。在 Settings → Secrets and variables → Actions 中配置
以下 **Repository secrets**（不是 Variables）。本地路径不能供 GitHub runner 使用。

| Secret | 内容 |
| --- | --- |
| `CSC_LINK` | `.p12` 完整文件的 Base64 内容（同样属于私钥机密） |
| `CSC_KEY_PASSWORD` | `.p12` 导出密码 |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple App 专用密码 |
| `APPLE_TEAM_ID` | `Q5N3RF9WVC` |

本人确认将签名私钥存入此仓库后，可在自己的终端使用已登录的 GitHub CLI：

```bash
# 直接通过 stdin 上传，不能把 base64 输出到聊天、日志或文件。
set -o pipefail
base64 < "$HOME/Documents/inno-agent-developer-id.p12" | gh secret set CSC_LINK --repo hhyqhh/inno-agent
# 以下命令分别交互输入值，不把密码放入命令行参数。
gh secret set CSC_KEY_PASSWORD --repo hhyqhh/inno-agent
gh secret set APPLE_ID --repo hhyqhh/inno-agent
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo hhyqhh/inno-agent
gh secret set APPLE_TEAM_ID --repo hhyqhh/inno-agent
```

macOS Release 工作流仍支持手动触发以及版本 tag 触发。
它使用单独的签名配置，强制签名；缺少凭据、公证失败或产物校验失败时不会上传 DMG。
`notarize: true` 本身不保证凭据缺失时失败，所以打包前额外校验必需环境变量。
上传/发布由 GitHub Actions 负责，electron-builder 使用 `--publish never`。
只有 tag 触发才自动创建 Release；手动构建只上传 Actions artifact。

仓库 CI 中持有发布私钥，请限制能修改/运行发布工作流的人员，并保护发布分支及 tag。
配置代码、上传 Secrets、推送代码和触发发布是不同操作，配置完成不代表已发布。

## 未签名内部测试

原有 `bash scripts/build-mac.sh` 继续作为内部未签名/临时签名打包方式，
不提供 Developer ID 和公证保证，不能代替对外发布的签名命令。
Windows/Linux 配置不受本次更改影响。
