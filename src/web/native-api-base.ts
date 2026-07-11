export function resolveNativeApiBase(configured: string | undefined, pageOrigin: string) {
  const value = configured?.trim();
  if (!value) return "";
  try {
    const origin = new URL(pageOrigin).origin;
    const resolved = new URL(value, `${origin}/`);
    if (resolved.protocol !== "https:" || !resolved.hostname || resolved.username || resolved.password) return "";
    return resolved.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
