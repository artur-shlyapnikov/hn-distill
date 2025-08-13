import { env } from "@config/env";

type Level = "debug" | "error" | "info" | "warn";
type LevelCfg = Level | "silent";

const order: Record<LevelCfg, number> = {
  silent: 99,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel: LevelCfg = env.LOG_LEVEL;

function shouldLog(level: Level): boolean {
  return order[level] <= order[currentLevel];
}

function ts(): string {
  return new Date().toISOString();
}

function emit(level: Level, scope: string, message: string, meta?: unknown): void {
  if (!shouldLog(level)) {
    return;
  }
  const line = `[${ts()}] ${level.toUpperCase()} ${scope}: ${message}`;
  let function_: typeof console.log;
  switch (level) {
    case "error": {
      // eslint-disable-next-line no-console
      function_ = console.error;

      break;
    }
    case "warn": {
      // eslint-disable-next-line no-console
      function_ = console.warn;

      break;
    }
    case "info": {
      // eslint-disable-next-line no-console
      function_ = console.info;

      break;
    }
    case "debug": {
      // eslint-disable-next-line no-console
      function_ = console.debug;

      break;
    }
  }
  if (meta === undefined) {
    function_(line);
  } else {
    try {
      function_(line, meta);
    } catch {
      function_(line);
    }
  }
}

export const log = {
  error(scope: string, message: string, meta?: unknown): void {
    emit("error", scope, message, meta);
  },
  warn(scope: string, message: string, meta?: unknown): void {
    emit("warn", scope, message, meta);
  },
  info(scope: string, message: string, meta?: unknown): void {
    emit("info", scope, message, meta);
  },
  debug(scope: string, message: string, meta?: unknown): void {
    emit("debug", scope, message, meta);
  },
};
