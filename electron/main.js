import { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// macOS 上避免未签名 app 触发钥匙串权限弹窗
app.commandLine.appendSwitch("use-mock-keychain");

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 路径 ─────────────────────────────────────────────────────────────────────
const isDev = !app.isPackaged;
const serverScript = isDev
  ? join(__dirname, "../apps/inno-agent/dist/server.js")
  : join(app.getAppPath(), "apps/inno-agent/dist/server.js");

const innoHome = join(homedir(), ".inno-agent");
const configDir = join(innoHome, "config");
const configPath = join(configDir, "config.json");
const PORT = 3000;

// ── 首次启动创建默认配置（不要求 API Key） ────────────────────────────────────
function ensureConfig() {
  if (existsSync(configPath)) return;
  mkdirSync(configDir, { recursive: true });
  const defaults = {
    defaultProvider: "default",
    defaultModel: "claude-sonnet-4-6",
    providers: {
      default: {
        baseUrl: "https://api.innospark.cn",
        api: "anthropic-messages",
        apiKey: "",
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "claude-sonnet-4-6",
            reasoning: false,
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
    server: { port: PORT },
    channels: {
      feishu: { enabled: false },
      qq: { enabled: false, mode: "bridge", sidecarBaseUrl: "http://127.0.0.1:4318" },
      wechat: { enabled: false, mode: "bridge", sidecarBaseUrl: "http://127.0.0.1:4319" },
    },
    bridge: { token: "" },
    subagents: { enabled: false },
  };
  writeFileSync(configPath, JSON.stringify(defaults, null, 2) + "\n");
}

// ── 全局状态 ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let loadingWindow = null;
let serverProcess = null;
let tray = null;

// ── Loading 窗口（服务启动期间显示） ────────────────────────────────────────
function openLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 400,
    height: 280,
    resizable: false,
    frame: false,
    backgroundColor: "#0f1117",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  loadingWindow.loadFile(join(__dirname, "loading.html"));
  loadingWindow.on("closed", () => { loadingWindow = null; });
}

// ── 主窗口 ────────────────────────────────────────────────────────────────────
function openMainWindow() {
  if (mainWindow) { mainWindow.focus(); return; }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Inno Agent",
    backgroundColor: "#0f1117",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // 关闭 loading 窗口
  loadingWindow?.close();

  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// ── 启动后端服务器 ────────────────────────────────────────────────────────────
function startServer(onReady) {
  process.env.INNO_HOME = innoHome;
  process.env.INNO_CONFIG_DIR = configDir;
  process.env.INNO_CONFIG_FILE = configPath;
  process.env.INNO_DATA_DIR = join(innoHome, "data");
  process.env.INNO_SKILLS_DIR = join(innoHome, "skills");
  process.env.INNO_WORKSPACE_DIR = join(homedir(), "Documents");
  process.env.INNO_PORT = String(PORT);

  serverProcess = spawn(process.execPath, [serverScript, "--server"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (d) => console.log("[server]", d.toString()));
  serverProcess.stderr.on("data", (d) => console.error("[server]", d.toString()));

  serverProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      dialog.showErrorBox(
        "Inno Agent 服务异常退出",
        `服务器进程以代码 ${code} 退出。\n请检查日志或重新启动应用。`
      );
    }
  });

  // 轮询 /health，最多等待 30s
  let elapsed = 0;
  const poll = setInterval(async () => {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) {
        clearInterval(poll);
        onReady?.();
      }
    } catch { /* 还未就绪 */ }
    elapsed += 500;
    if (elapsed >= 30000) clearInterval(poll);
  }, 500);
}

// ── 应用生命周期 ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Inno Agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开 Inno Agent",
        click: () => { if (mainWindow) mainWindow.show(); else openMainWindow(); },
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ])
  );
  tray.on("click", () => { if (mainWindow) mainWindow.show(); else openMainWindow(); });

  ensureConfig();
  openLoadingWindow();
  startServer(() => openMainWindow());
});

app.on("window-all-closed", () => {
  // macOS 上关闭所有窗口不退出，保持在托盘运行
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!app.isReady()) return;
  if (mainWindow) mainWindow.show();
});

app.on("before-quit", () => {
  serverProcess?.kill();
});
