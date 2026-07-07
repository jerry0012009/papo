import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const local = loadEnvFile(env.PAPO_ENV_PATH ?? path.join(process.cwd(), ".env"));
  return { ...local, ...env };
}

function loadEnvFile(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) return {};
  const parsed: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const raw = trimmed.slice(separator + 1).trim();
    parsed[key] = raw.replace(/^['"]|['"]$/g, "");
  }
  return parsed;
}
