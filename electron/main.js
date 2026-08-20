import { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, ipcMain, screen } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    ui: { theme: "light", closeBehavior: "ask" },
  };
  writeFileSync(configPath, JSON.stringify(defaults, null, 2) + "\n", { mode: 0o600 });
}

// ── 全局状态 ──────────────────────────────────────────────────────────────────
let mainWindow = null;
let loadingWindow = null;
let serverProcess = null;
let tray = null;
let isQuitting = false;
let isCloseDialogOpen = false;
let closeDialogCopy = {
  title: "关闭 Inno Agent",
  message: "要如何关闭 Inno Agent？",
  detail: "选择“关闭窗口”会让应用继续在后台运行；选择“退出应用”会停止后台服务。勾选“记住我的选择”后，下次将直接使用该选择，也可以在设置 > 通用中修改。",
  buttons: {
    hide: "关闭窗口",
    quit: "退出应用",
    cancel: "取消",
  },
  remember: "记住我的选择",
};

function isCloseDialogCopy(value) {
  if (!value || typeof value !== "object") return false;
  const copy = value;
  const buttons = copy.buttons;
  return typeof copy.title === "string"
    && typeof copy.message === "string"
    && typeof copy.detail === "string"
    && typeof copy.remember === "string"
    && buttons
    && typeof buttons === "object"
    && typeof buttons.hide === "string"
    && typeof buttons.quit === "string"
    && typeof buttons.cancel === "string";
}

ipcMain.on("inno-close-dialog-copy", (_event, copy) => {
  if (!isCloseDialogCopy(copy)) return;
  closeDialogCopy = {
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    buttons: {
      hide: copy.buttons.hide,
      quit: copy.buttons.quit,
      cancel: copy.buttons.cancel,
    },
    remember: copy.remember,
  };
});

const MAX_WINDOW_EXPANSION = 1200;

function isWindowExpansionRequest(value) {
  return value
    && typeof value === "object"
    && (value.side === "left" || value.side === "right")
    && Number.isFinite(value.additionalWidth)
    && value.additionalWidth >= 0;
}

ipcMain.handle("inno-expand-window-width", (event, request) => {
  if (!isWindowExpansionRequest(request)
    || !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents) {
    return false;
  }

  const additionalWidth = Math.min(Math.round(request.additionalWidth), MAX_WINDOW_EXPANSION);
  if (additionalWidth === 0) return true;

  const currentBounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(currentBounds);
  const workArea = display.workArea;
  const nextWidth = currentBounds.width + additionalWidth;

  // Never expand beyond the usable display area. In that case the renderer
  // keeps the panel collapsed instead of squeezing the chat into the gap.
  if (nextWidth > workArea.width) return false;

  const requestedX = request.side === "left"
    ? currentBounds.x - additionalWidth
    : currentBounds.x;
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - nextWidth;
  const nextX = Math.max(minX, Math.min(requestedX, maxX));

  mainWindow.setBounds({
    ...currentBounds,
    x: nextX,
    width: nextWidth,
  }, true);
  return true;
});

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
function getConfiguredCloseBehavior() {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const behavior = raw?.ui?.closeBehavior;
    if (behavior === "hide" || behavior === "quit") return behavior;
  } catch { /* 配置尚未生成或无法读取时使用安全默认值 */ }
  return "ask";
}

async function rememberCloseBehavior(closeBehavior) {
  try {
    const response = await fetch(`http://localhost:${PORT}/api/settings/close-behavior`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closeBehavior }),
    });
    if (response.ok) return;
    throw new Error(`settings request failed with status ${response.status}`);
  } catch (error) {
    // Keep the preference even if the local server is already stopping.
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const ui = raw?.ui && typeof raw.ui === "object" && !Array.isArray(raw.ui) ? raw.ui : {};
      raw.ui = { ...ui, closeBehavior };
      writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
    } catch (fallbackError) {
      console.warn("[window] failed to remember close behavior", error, fallbackError);
    }
  }
}

function quitApplication() {
  isQuitting = true;
  // If called from the window's `close` event, wait until the current event
  // finishes before asking Electron to close the window again.
  setImmediate(() => app.quit());
}

async function askCloseBehavior() {
  if (isCloseDialogOpen || !mainWindow || mainWindow.isDestroyed()) return;
  isCloseDialogOpen = true;

  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: closeDialogCopy.title,
      message: closeDialogCopy.message,
      detail: closeDialogCopy.detail,
      buttons: [closeDialogCopy.buttons.hide, closeDialogCopy.buttons.quit, closeDialogCopy.buttons.cancel],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: closeDialogCopy.remember,
      noLink: true,
    });

    if (!mainWindow || mainWindow.isDestroyed()) return;
    const selectedBehavior = result.response === 0 ? "hide" : result.response === 1 ? "quit" : null;
    if (!selectedBehavior) return;
    if (result.checkboxChecked) await rememberCloseBehavior(selectedBehavior);

    if (selectedBehavior === "hide") {
      mainWindow.hide();
    } else {
      quitApplication();
    }
  } catch (error) {
    console.warn("[window] close confirmation failed", error);
  } finally {
    isCloseDialogOpen = false;
  }
}

function openMainWindow() {
  if (mainWindow) { mainWindow.focus(); return; }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Inno Agent",
    backgroundColor: "#0f1117",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // 关闭 loading 窗口
  loadingWindow?.close();

  // 关闭按钮的行为由跨平台设置决定：询问、隐藏窗口或退出应用。
  mainWindow.on("close", (event) => {
    if (isQuitting) return;

    const behavior = getConfiguredCloseBehavior();
    if (behavior === "hide") {
      event.preventDefault();
      mainWindow.hide();
    } else if (behavior === "ask") {
      event.preventDefault();
      void askCloseBehavior();
    } else {
      event.preventDefault();
      quitApplication();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only http(s) may leave the app — file://, smb:// and custom schemes
    // handed to shell.openExternal can trigger OS-level handlers (issue #162).
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "https:" || protocol === "http:") {
        shell.openExternal(url);
      }
    } catch {
      // unparseable URL — deny
    }
    return { action: "deny" };
  });
}

function showMainWindow() {
  if (!mainWindow) {
    openMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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
        click: showMainWindow,
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ])
  );
  tray.on("click", showMainWindow);

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
  showMainWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  serverProcess?.kill();
});
