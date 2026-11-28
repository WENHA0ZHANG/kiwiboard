import { AsyncLocalStorage } from "node:async_hooks";

// Counts the outbound fetch() calls made inside countSubrequests(), so each
// cron run can log how much of the free plan's 50-per-invocation budget it
// used. Only calls made from that run's async context are counted, not those
// of requests served at the same time. D1 calls don't go through fetch and
// have their own, much higher limit.
const store = new AsyncLocalStorage<{ n: number }>();
let installed: boolean | null = null;

function install(): boolean {
  if (installed !== null) return installed;
  try {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const counter = store.getStore();
      if (counter) counter.n++;
      return realFetch(input, init);
    }) as typeof fetch;
    installed = true;
  } catch (e) {
    console.error("countSubrequests: could not wrap fetch", e);
    installed = false;
  }
  return installed;
}

/** Runs `fn` and returns how many fetch() calls it made (null if not countable). */
export async function countSubrequests<T>(fn: () => Promise<T>): Promise<{ result: T; requests: number | null }> {
  const ok = install();
  const counter = { n: 0 };
  const result = await store.run(counter, fn);
  return { result, requests: ok ? counter.n : null };
}
