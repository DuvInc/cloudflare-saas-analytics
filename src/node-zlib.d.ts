/* The one Node API used (nodejs_compat), without pulling @types/node into the Worker. */
declare module "node:zlib" {
  export function gunzipSync(data: Uint8Array): { toString(encoding: "utf8"): string };
}
