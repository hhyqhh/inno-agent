import { execFile } from "node:child_process";

// Query Launch Services via AppKit. The file path is an argv value, not script
// source; neither file names nor application paths are evaluated as commands.
const APPLICATIONS_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const preferred = workspace.URLForApplicationToOpenURL(url);
  const preferredPath = preferred.isNil() ? '' : ObjC.unwrap(preferred.path);
  const urls = workspace.URLsForApplicationsToOpenURL(url);
  const result = [];
  for (let i = 0; i < urls.count; i++) {
    const path = ObjC.unwrap(urls.objectAtIndex(i).path);
    const name = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(path)).replace(/\\.app$/i, '');
    let icon;
    try {
      // Electron getFileIcon resolves .app through its shared file type and
      // returns the same generic icon. AppKit reads the actual bundle icon.
      const image = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
      image.lockFocus;
      workspace.iconForFile(path).drawInRectFromRectOperationFraction(
        $.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
      image.unlockFocus;
      const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
      const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      icon = "data:image/png;base64," + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
    } catch { /* A missing icon must not hide an otherwise usable application. */ }
    result.push({ id: path, name, isDefault: path === preferredPath, ...(icon ? { icon } : {}) });
  }
  return JSON.stringify(result);
}`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 8_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

export async function listFileApplications(filePath, platform = process.platform) {
  // Other desktop platforms retain their native default-file association.
  // macOS exposes the registered, format-specific applications through AppKit.
  if (platform !== "darwin") return [{ id: "system-default", name: "", isDefault: true }];
  const result = JSON.parse(await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", APPLICATIONS_SCRIPT, filePath]));
  if (!Array.isArray(result)) throw new Error("Invalid application list");
  const unique = new Map();
  for (const entry of result) {
    if (entry && typeof entry.id === "string" && entry.id.startsWith("/") && entry.id.endsWith(".app") && typeof entry.name === "string") {
      unique.set(entry.id, { id: entry.id, name: entry.name, isDefault: entry.isDefault === true,
        ...(typeof entry.icon === "string" && entry.icon.startsWith("data:image/png;base64,") ? { icon: entry.icon } : {}) });
    }
  }
  const apps = [...unique.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  if (!apps.some((entry) => entry.isDefault)) apps.unshift({ id: "system-default", name: "", isDefault: true });
  return apps;
}

export async function openFileInApplication(filePath, applicationId) {
  // Only the main process calls this after validating the current association
  // list. execFile keeps spaces, quotes and shell metacharacters literal.
  await run("/usr/bin/open", ["-a", applicationId, filePath]);
}
