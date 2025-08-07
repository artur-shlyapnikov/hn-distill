import { env } from "@config/env";

type Level = "error" | "warn" | "info" | "debug";
type LevelCfg = "silent" | Level;

const order: Record<LevelCfg, number> = {
  silent: 99,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel: LevelCfg = env.LOG_LEVEL ?? "info";

function shouldLog(level: Level): boolean {
  return order[level] <= order[currentLevel];
}

function ts(): string {
  return new Date().toISOString();
}

function emit(level: Level, scope: string, msg: string, meta?: unknown): void {
  if (!shouldLog(level)) return;
  const line = `[${ts()}] ${level.toUpperCase()} ${scope}: ${msg}`;
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "info"
          ? console.info
          : console.debug;
  if (meta !== undefined) {
    try {
      fn(line, meta);
    } catch {
      fn(line);
    }
  } else {
    fn(line);
  }
}

export const log = {
  error(scope: string, msg: string, meta?: unknown) {
    emit("error", scope, msg, meta);
  },
  warn(scope: string, msg: string, meta?: unknown) {
    emit("warn", scope, msg, meta);
  },
  info(scope: string, msg: string, meta?: unknown) {
    emit("info", scope, msg, meta);
  },
  debug(scope: string, msg: string, meta?: unknown) {
    emit("debug", scope, msg, meta);
  },
};
