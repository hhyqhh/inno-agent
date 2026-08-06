const { contextBridge, ipcRenderer } = require("electron");

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

contextBridge.exposeInMainWorld("innoDesktop", {
  setCloseDialogCopy(copy) {
    if (isCloseDialogCopy(copy)) {
      ipcRenderer.send("inno-close-dialog-copy", copy);
    }
  },
});
