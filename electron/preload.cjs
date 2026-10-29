const { contextBridge, ipcRenderer, webUtils } = require("electron");

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

function isWindowExpansionSide(value) {
  return value === "left" || value === "right";
}

function isSearchResult(value) {
  if (!value || typeof value !== "object") return false;
  const result = value;
  if (typeof result.id !== "string" || typeof result.title !== "string"
    || typeof result.subtitle !== "string" || typeof result.snippet !== "string") return false;
  if (!["conversation", "workspace", "file", "knowledge"].includes(result.category)) return false;
  if (result.category === "conversation") return typeof result.sessionId === "string";
  if (result.category === "workspace") return typeof result.workspaceId === "string";
  if (result.category === "file") return typeof result.workspaceId === "string" && typeof result.path === "string";
  return typeof result.path === "string";
}

contextBridge.exposeInMainWorld("innoDesktop", {
  resizeWindow(action, edge) {
    if (!["start", "update", "end", "cancel"].includes(action)) return;
    if (action === "start" && !["n", "s", "e", "w", "ne", "nw", "se", "sw"].includes(edge)) return;
    ipcRenderer.send("inno-resize-window", { action, edge: action === "start" ? edge : undefined });
  },
	setThemePreference(preference) {
		if (!["light", "dark", "system"].includes(preference)) return Promise.resolve(null);
		return ipcRenderer.invoke("inno-set-theme-preference", preference);
	},
  setCloseDialogCopy(copy) {
    if (isCloseDialogCopy(copy)) {
      ipcRenderer.send("inno-close-dialog-copy", copy);
    }
  },
  async openLocalFile(file) {
    if (!file || typeof file !== "object") return false;
    let path = "";
    try {
      path = webUtils.getPathForFile(file) || "";
    } catch {
      path = "";
    }
    if (!path) return false;
    const error = await ipcRenderer.invoke("inno-open-path", path);
    return typeof error === "string" && error.length === 0;
  },
  getWorkspaceFileApplications(path, workspaceId) {
    if (typeof path !== "string" || !path || (workspaceId != null && typeof workspaceId !== "string")) return Promise.resolve(null);
    return ipcRenderer.invoke("inno-workspace-file-applications", { path, workspaceId });
  },
  revealWorkspaceFile(path, workspaceId) {
    if (typeof path !== "string" || !path || (workspaceId != null && typeof workspaceId !== "string")) return Promise.resolve(false);
    return ipcRenderer.invoke("inno-reveal-workspace-file", { path, workspaceId });
  },
  openWorkspaceFile(path, workspaceId, applicationId) {
    if (typeof path !== "string" || !path || (workspaceId != null && typeof workspaceId !== "string")) {
      return Promise.resolve(false);
    }
    if (applicationId != null && typeof applicationId !== "string") return Promise.resolve(false);
    return ipcRenderer.invoke("inno-open-workspace-file", { path, workspaceId, applicationId });
  },
  expandWindowWidth(side, additionalWidth) {
    if (!isWindowExpansionSide(side) || !Number.isFinite(additionalWidth) || additionalWidth < 0) {
      return Promise.resolve(false);
    }
    return ipcRenderer.invoke("inno-expand-window-width", { side, additionalWidth });
  },
  getWindowWidthCapacity(side) {
    if (!isWindowExpansionSide(side)) return Promise.resolve(0);
    return ipcRenderer.invoke("inno-window-width-capacity", side);
  },
  isFullScreen() {
    return ipcRenderer.invoke("inno-is-full-screen");
  },
  onFullScreenChange(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, isFullScreen) => {
      if (typeof isFullScreen === "boolean") callback(isFullScreen);
    };
    ipcRenderer.on("inno-full-screen-change", listener);
    return () => ipcRenderer.removeListener("inno-full-screen-change", listener);
  },
	openSearchWindow(theme) {
		return ipcRenderer.invoke("inno-open-search-window", theme);
  },
  closeSearchWindow() {
    ipcRenderer.send("inno-close-search-window");
  },
  openSearchResult(result) {
    if (isSearchResult(result)) ipcRenderer.send("inno-search-open-result", result);
  },
  onSearchNavigation(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, result) => {
      if (isSearchResult(result)) callback(result);
    };
    ipcRenderer.on("inno-search-navigate", listener);
    return () => ipcRenderer.removeListener("inno-search-navigate", listener);
  },
});
