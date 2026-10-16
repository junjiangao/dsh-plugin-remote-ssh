/**
 * Tiny check runner shared by verification/static-check.mjs and verification/e2e.mjs.
 * Every check is recorded with its id, method/evidence, result and notes so the
 * report can be assembled from real output.
 */

export function createSuite(title) {
  const results = [];
  const started = Date.now();

  return {
    title,
    results,
    /**
     * @param {string} id          stable check id (used in REPORT.md)
     * @param {string} description what is being checked
     * @param {() => any} fn       returns notes (string) on success; throw to fail
     */
    async check(id, description, fn) {
      const t0 = Date.now();
      let record;
      try {
        const notes = await fn();
        record = { id, description, ok: true, ms: Date.now() - t0, notes: notes == null ? '' : String(notes) };
      } catch (error) {
        record = {
          id,
          description,
          ok: false,
          ms: Date.now() - t0,
          notes: error?.stack ? `${error.message}\n${error.stack.split('\n').slice(1, 4).join('\n')}` : String(error),
        };
      }
      results.push(record);
      const status = record.ok ? 'PASS' : 'FAIL';
      const notes = record.notes ? `  ${record.notes.split('\n')[0]}` : '';
      process.stdout.write(`${status}  ${id.padEnd(34)} ${description} (${record.ms}ms)${notes}\n`);
      return record;
    },

    summary() {
      const failed = results.filter((r) => !r.ok);
      const passed = results.length - failed.length;
      process.stdout.write(`\n${title}: ${passed} passed, ${failed.length} failed, ${results.length} total `
        + `(${Date.now() - started}ms)\n`);
      if (failed.length > 0) {
        process.stdout.write('FAILED CHECKS:\n');
        for (const f of failed) process.stdout.write(`  - ${f.id}: ${f.description}\n    ${f.notes}\n`);
      }
      return { passed, failed: failed.length, total: results.length, failures: failed };
    },
  };
}

export class CheckFailure extends Error {}

export function fail(message) {
  throw new CheckFailure(message);
}

export function assert(condition, message) {
  if (!condition) fail(message);
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label ?? 'value'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Wall-clock cap around an async operation; fails loudly instead of hanging. */
export async function withCap(ms, label, fn) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CheckFailure(`${label}: exceeded ${ms}ms wall-clock cap (possible hang)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
