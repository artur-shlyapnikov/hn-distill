import { env as realEnv } from "@config/env";

export async function withEnvPatch<T>(patch: Partial<typeof realEnv>, fn: () => Promise<T>): Promise<T> {
  const snapshot = { ...realEnv };
  Object.assign(realEnv, patch);
  try {
    return await fn();
  } finally {
    Object.assign(realEnv, snapshot);
  }
}