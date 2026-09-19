/**
 * Minimal test harness — same hand-rolled style as src/sisa-regression.test.ts.
 * No test framework dependency; files exit non-zero when anything failed.
 */

let passed = 0;
let failed = 0;

export function describe(name: string): void {
  console.log(`\n— ${name}`);
}

export async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${(err as Error).message.split('\n').join('\n       ')}`);
  }
}

function fail(msg: string): never {
  throw new Error(msg);
}

export function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) fail(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

export function deepEq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${msg}: expected ${b}, got ${a}`);
}

export function ok(cond: unknown, msg: string): void {
  if (!cond) fail(`${msg}: expected truthy, got ${String(cond)}`);
}

export function gt(a: number, b: number, msg: string): void {
  if (!(a > b)) fail(`${msg}: expected ${a} > ${b}`);
}

export function gte(a: number, b: number, msg: string): void {
  if (!(a >= b)) fail(`${msg}: expected ${a} >= ${b}`);
}

/** Assert that fn rejects with an error whose message or SQLSTATE contains `code`. */
export async function expectErr(
  fn: () => Promise<unknown>,
  code: string,
  msg: string,
): Promise<Error> {
  let err: unknown = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  if (err === null) fail(`${msg}: expected error containing "${code}", but nothing was thrown`);
  const e = err as Error & { code?: string };
  const haystack = `${String(e.message ?? err)} | code=${String(e.code ?? '')}`;
  if (!haystack.includes(code)) fail(`${msg}: expected error containing "${code}", got: ${haystack}`);
  return e;
}

/** Print the summary and return the process exit code. */
export function summary(label: string): number {
  console.log(`\n${label}: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}
