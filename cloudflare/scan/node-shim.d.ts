// The scan runs on Node, but the project doesn't install @types/node (the
// Worker's code is typed against @cloudflare/workers-types). Declare the few
// Node APIs market-scan.ts uses.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};
declare const __dirname: string;
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
