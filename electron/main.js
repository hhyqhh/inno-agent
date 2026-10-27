import { listFileApplications, openFileInApplication } from "./open-with.js";
import { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, ipcMain, screen } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { join, dirname, isAbsolute } from "node:path";
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
const DEFAULT_PORT = 3000;
let serverPort = DEFAULT_PORT;

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
    server: { port: DEFAULT_PORT },
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
let searchWindow = null;
let loadingWindow = null;
let serverProcess = null;
let tray = null;
let isQuitting = false;
let isCloseDialogOpen = false;
let pendingSearchNavigation = null;
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

ipcMain.handle("inno-open-path", (event, path) => {
  if (typeof path !== "string"
    || path.length === 0
    || !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents) {
    return "";
  }
  return shell.openPath(path);
});

// All native actions resolve the original file in its owning workspace.
function isWorkspaceFileRequest(event, request) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
    && !!request && typeof request.path === "string" && !!request.path
    && (request.workspaceId == null || typeof request.workspaceId === "string");
}
async function resolveWorkspaceFile(request) {
  const params = new URLSearchParams({ path: request.path });
  if (request.workspaceId) params.set("workspaceId", request.workspaceId);
  const response = await fetch(`http://localhost:${serverPort}/api/workspace/file-location?${params}`, {
    signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  if (!response.ok) throw new Error("File unavailable");
  const result = await response.json();
  if (typeof result.absolutePath !== "string" || !isAbsolute(result.absolutePath)) throw new Error("Invalid file location");
  return result.absolutePath;
}

ipcMain.handle("inno-workspace-file-applications", async (event, request) => {
  if (!isWorkspaceFileRequest(event, request)) return null;
  try {
    const path = await resolveWorkspaceFile(request);
    let apps;
    let unavailable = false;
    try { apps = await listFileApplications(path); }
    catch { apps = [{ id: "system-default", name: "", isDefault: true }]; unavailable = true; }
    const applications = await Promise.all(apps.map(async (entry) => {
      if (entry.icon) return entry;
      try { return { ...entry, icon: (await app.getFileIcon(entry.id === "system-default" ? path : entry.id, { size: "small" })).toDataURL() }; }
      catch { return entry; }
    }));
    return { applications, unavailable, fileManager: process.platform === "darwin" ? "finder" : process.platform === "win32" ? "explorer" : "files" };
  } catch { return null; }
});

ipcMain.handle("inno-open-workspace-file", async (event, request) => {
  if (!isWorkspaceFileRequest(event, request) || (request.applicationId != null && typeof request.applicationId !== "string")) return false;
  try {
    const path = await resolveWorkspaceFile(request);
    if (!request.applicationId || request.applicationId === "system-default") return (await shell.openPath(path)) === "";
    // A renderer cannot substitute an executable: only current system-registered
    // applications for this particular file are accepted.
    const apps = await listFileApplications(path);
    if (!apps.some((entry) => entry.id === request.applicationId)) return false;
    await openFileInApplication(path, request.applicationId);
    return true;
  } catch { return false; }
});

ipcMain.handle("inno-reveal-workspace-file", async (event, request) => {
  if (!isWorkspaceFileRequest(event, request)) return false;
  try { shell.showItemInFolder(await resolveWorkspaceFile(request)); return true; }
  catch { return false; }
});

ipcMain.handle("inno-is-full-screen", (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  return mainWindow.isFullScreen();
});

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

function isSearchResult(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof value.id !== "string" || typeof value.title !== "string"
    || typeof value.subtitle !== "string" || typeof value.snippet !== "string") return false;
  if (!["conversation", "workspace", "file", "knowledge"].includes(value.category)) return false;
  if (value.category === "conversation") return typeof value.sessionId === "string";
  if (value.category === "workspace") return typeof value.workspaceId === "string";
  if (value.category === "file") return typeof value.workspaceId === "string" && typeof value.path === "string";
  return typeof value.path === "string";
}

function sendPendingSearchNavigation() {
  if (!pendingSearchNavigation || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  const result = pendingSearchNavigation;
  pendingSearchNavigation = null;
  mainWindow.webContents.send("inno-search-navigate", result);
}

function bindSearchShortcut(window) {
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key?.toLowerCase() !== "k") return;
    if (!(input.meta || input.control) || input.alt || input.shift) return;
    event.preventDefault();
    void window.webContents.executeJavaScript("document.documentElement.dataset.theme")
      .then((theme) => openSearchWindow(theme === "dark" ? "dark" : "light"))
      .catch(() => openSearchWindow());
  });
}

function openSearchWindow(theme = "light") {
  const backgroundColor = theme === "dark" ? "#171717" : "#f5f7fa";
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.setBackgroundColor(backgroundColor);
    if (searchWindow.isMinimized()) searchWindow.restore();
    searchWindow.show();
    searchWindow.focus();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) openMainWindow();

  searchWindow = new BrowserWindow({
    width: 800,
    height: 640,
    center: true,
    minWidth: 560,
    minHeight: 420,
    title: "Inno Agent Search",
    modal: false,
    titleBarStyle: process.platform === "darwin" ? "hidden" : undefined,
    trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 12 } : undefined,
    backgroundColor,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.cjs"),
      zoomFactor: 1,
    },
  });
  const searchWindowUrl = new URL(`http://localhost:${serverPort}/`);
  searchWindowUrl.searchParams.set("window", "search");
  if (process.platform === "darwin") searchWindowUrl.searchParams.set("macTitlebar", "1");
  searchWindow.loadURL(searchWindowUrl.toString());
  searchWindow.webContents.on("did-finish-load", () => {
    if (searchWindow && !searchWindow.isDestroyed()) searchWindow.webContents.setZoomFactor(1);
  });
  bindSearchShortcut(searchWindow);
  searchWindow.on("closed", () => { searchWindow = null; });
  searchWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "https:" || protocol === "http:") shell.openExternal(url);
    } catch { /* deny unparseable URL */ }
    return { action: "deny" };
  });
  searchWindow.show();
  searchWindow.focus();
}

ipcMain.handle("inno-open-search-window", (event, theme) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  openSearchWindow(theme === "dark" ? "dark" : "light");
  return true;
});

ipcMain.on("inno-close-search-window", (event) => {
  if (searchWindow && event.sender === searchWindow.webContents) searchWindow.close();
});

ipcMain.on("inno-search-open-result", (event, result) => {
  if (!searchWindow || event.sender !== searchWindow.webContents || !isSearchResult(result)) return;
  pendingSearchNavigation = result;
  showMainWindow();
  sendPendingSearchNavigation();
  searchWindow?.close();
});

const MAX_WINDOW_EXPANSION = 1200;

function isWindowExpansionSide(value) {
  return value === "left" || value === "right";
}

function isWindowExpansionRequest(value) {
  return value
    && typeof value === "object"
    && isWindowExpansionSide(value.side)
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

ipcMain.handle("inno-window-width-capacity", (event, side) => {
  if (!isWindowExpansionSide(side)
    || !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents) {
    return 0;
  }

  const currentBounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(currentBounds);
  const workArea = display.workArea;
  const capacity = side === "left"
    ? currentBounds.x - workArea.x
    : workArea.x + workArea.width - (currentBounds.x + currentBounds.width);
  return Math.max(0, Math.min(MAX_WINDOW_EXPANSION, Math.floor(capacity)));
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
    const response = await fetch(`http://localhost:${serverPort}/api/settings/close-behavior`, {
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

/**
 * Probe a port using the same wildcard bind as the HTTP server. The probe is
 * closed before returning; the server child receives the selected port and
 * owns the real listener.
 */
function probePort(port) {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(port, () => {
      const address = probe.address();
      const selectedPort = address && typeof address === "object" ? address.port : port;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(selectedPort);
      });
    });
  });
}

/**
 * Keep the conventional port when possible, but let the desktop app coexist
 * with a separately started dev server, Docker container, or another Inno
 * instance. Without this negotiation the child exits with EADDRINUSE while
 * the renderer may accidentally attach to the other process on port 3000.
 */
async function selectServerPort() {
  try {
    return await probePort(DEFAULT_PORT);
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    const fallbackPort = await probePort(0);
    console.warn(`[server] port ${DEFAULT_PORT} is busy; using port ${fallbackPort}`);
    return fallbackPort;
  }
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
    // Match the 560px chat minimum plus the persistent 52px desktop rail.
    // The old native 800px floor blocked shrinking before renderer layout ran.
    minWidth: 612,
    minHeight: 600,
    title: "Inno Agent",
    // Keep the macOS traffic lights, but let the renderer own the area below
    // them so the app no longer gets the separate native title-bar strip.
    titleBarStyle: process.platform === "darwin" ? "hidden" : undefined,
    trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 18 } : undefined,
    backgroundColor: "#0f1117",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.cjs"),
      zoomFactor: 1,
    },
  });

  mainWindow.on("enter-full-screen", () => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send("inno-full-screen-change", true);
  });
  mainWindow.on("leave-full-screen", () => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send("inno-full-screen-change", false);
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  // Chromium remembers per-origin page zoom. Reset it for the local app so a
  // previous Ctrl +/- does not compound Windows display scaling on restart.
  mainWindow.webContents.on("did-finish-load", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomFactor(1);
    }
    sendPendingSearchNavigation();
  });
  bindSearchShortcut(mainWindow);

  // 原生右键菜单：Electron 默认不弹出系统菜单，这里补上文本编辑的基础项。
  mainWindow.webContents.on("context-menu", (event, params) => {
    const items = [];
    if (params.selectionText) {
      items.push({ role: "cut", label: "剪切", enabled: params.isEditable });
      items.push({ role: "copy", label: "复制" });
    }
    if (params.isEditable) {
      items.push({ role: "paste", label: "粘贴" });
      items.push({ role: "selectAll", label: "全选" });
    }
    if (items.length === 0) return;
    const menu = Menu.buildFromTemplate(items);
    menu.popup({ window: mainWindow });
  });

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
async function startServer(onReady) {
  let serverOutput = "";
  let failureReported = false;
  let poll = null;

  const appendServerOutput = (chunk) => {
    serverOutput = `${serverOutput}${chunk.toString()}`.slice(-8000);
  };
  const reportFailure = (message) => {
    if (failureReported || isQuitting) return;
    failureReported = true;
    if (poll) clearInterval(poll);
    const output = serverOutput.trim();
    const detail = output
      ? `${message}\n\n后端输出：\n${output}\n\n日志目录：${join(innoHome, "data", "log")}`
      : `${message}\n\n日志目录：${join(innoHome, "data", "log")}`;
    dialog.showErrorBox("Inno Agent 服务启动失败", detail);
  };

  try {
    serverPort = await selectServerPort();
  } catch (error) {
    reportFailure(`无法为后端服务分配端口：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (isQuitting) return;

  process.env.INNO_HOME = innoHome;
  process.env.INNO_CONFIG_DIR = configDir;
  process.env.INNO_CONFIG_FILE = configPath;
  process.env.INNO_DATA_DIR = join(innoHome, "data");
  process.env.INNO_SKILLS_DIR = join(innoHome, "skills");
  process.env.INNO_WORKSPACE_DIR = join(homedir(), "Documents");
  process.env.INNO_PORT = String(serverPort);

  serverProcess = spawn(process.execPath, [serverScript, "--server", "--port", String(serverPort)], {
    // INNO_DESKTOP marks the desktop (Electron) runtime: gates desktop-only
    // capabilities like computer-use (see plugins.computerUse in config.ts).
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      INNO_DESKTOP: "1",
      ...(app.isPackaged ? { INNO_BUNDLED_TOOLS_DIR: process.resourcesPath } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (d) => {
    appendServerOutput(d);
    console.log("[server]", d.toString());
  });
  serverProcess.stderr.on("data", (d) => {
    appendServerOutput(d);
    console.error("[server]", d.toString());
  });

  serverProcess.on("error", (error) => {
    appendServerOutput(error.stack || error.message);
    reportFailure(`无法启动后端进程：${error.message}`);
  });

  serverProcess.on("exit", (code, signal) => {
    if (isQuitting) return;
    if (code !== 0 && code !== null) {
      reportFailure(`服务器进程以代码 ${code} 退出。`);
    } else if (signal) {
      reportFailure(`服务器进程被信号 ${signal} 终止。`);
    }
  });

  // 轮询 /health，最多等待 30s
  let elapsed = 0;
  poll = setInterval(async () => {
    try {
      const r = await fetch(`http://localhost:${serverPort}/health`);
      if (r.ok) {
        clearInterval(poll);
        poll = null;
        onReady?.();
      }
    } catch { /* 还未就绪 */ }
    elapsed += 500;
    if (elapsed >= 30000) {
      reportFailure("后端服务在 30 秒内未能就绪。");
    }
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
