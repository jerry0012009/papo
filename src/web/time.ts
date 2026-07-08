const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export const papoTimeZone = normalizeTimeZone(import.meta.env.VITE_PAPO_TIME_ZONE) ?? DEFAULT_TIME_ZONE;

export function formatPapoDateTime(value: string | Date | undefined) {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: papoTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function normalizeTimeZone(value?: string) {
  const timeZone = value?.trim();
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return undefined;
  }
}
