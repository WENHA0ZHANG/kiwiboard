// The Workers runtime provides node:async_hooks under the nodejs_compat flag
// (wrangler.toml); this project doesn't install @types/node, so declare the
// one class lib/subrequests.ts uses.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
