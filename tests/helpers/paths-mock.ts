import { mock } from "bun:test";
import { makeTmpPATHS, makeTmpPathFor } from "./tempfs";

export function mockPaths(base: string) {
  const PATHS = makeTmpPATHS(base);
  const pathFor = makeTmpPathFor(PATHS);
  mock.module("@config/paths", () => ({ PATHS, pathFor }));
  return { PATHS, pathFor };
}