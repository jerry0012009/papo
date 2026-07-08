export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export function configuredTimeZone() {
  const env = typeof process !== "undefined" ? process.env.PAPO_TIME_ZONE : undefined;
  return normalizeTimeZone(env) ?? DEFAULT_TIME_ZONE;
}

export function normalizeTimeZone(value?: string) {
  const timeZone = value?.trim();
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return undefined;
  }
}

export function formatZonedDateTime(value: string | Date, timeZone = configuredTimeZone()) {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

export function modelTimeContext(now = new Date().toISOString(), timeZone = configuredTimeZone()) {
  return {
    iso: now,
    timeZone,
    localDateTime: formatZonedDateTime(now, timeZone)
  };
}

export function addMinutes(iso: string, minutes: number) {
  const base = Date.parse(iso);
  const at = Number.isFinite(base) ? base : Date.now();
  return new Date(at + minutes * 60_000).toISOString();
}
