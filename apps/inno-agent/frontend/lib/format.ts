function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Bytes → "592.0 KB" / "3.0 MB" (16.6 MB style). */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const v = value >= 100 ? Math.round(value) : value.toFixed(1);
  return `${v} ${units[unit]}`;
}

/** Milliseconds → compact Chinese duration: 2m14s / 45s / 1h5m. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/** Unix ms → compact relative time: 刚刚 / 10:18 / 2小时前. */
export function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const day = 86_400_000;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
  const d = new Date(timestamp);
  const now = new Date();
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Absolute hh:mm for a timestamp, e.g. "10:18". */
export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Trim a workspace name to a short pill: strip a trailing 工作区/任务/备课. */
export function shortWorkspaceName(name: string): string {
  return name.replace(/工作区$/, "").replace(/任务$/, "").trim() || name;
}
