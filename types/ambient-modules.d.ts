declare module "he" {
  const he: {
    decode: (text: string) => string;
    encode?: (text: string) => string;
  };
  export default he;
}

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>, timeout?: number): void;

  interface ExpectMatchers<T = any> {
    toBe(expected: T): void;
    toEqual(expected: T): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeTrue(): void;
    toBeFalse(): void;
    toContain(expected: any): void;
    toMatch(expected: string | RegExp): void;
    toThrow(expected?: string | RegExp | Error): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeInstanceOf(expected: new (...args: any[]) => any): void;
    not: ExpectMatchers<T>;
  }

  interface ExpectMatchersAsync<T = any> extends ExpectMatchers<T> {
    resolves: ExpectMatchers<T>;
    rejects: ExpectMatchers<T>;
  }

  export function expect<T>(
    actual: T
  ): ExpectMatchers<T> &
    (T extends Promise<infer U> ? { resolves: ExpectMatchers<U>; rejects: ExpectMatchers<any> } : object);
  export function afterAll(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
}
