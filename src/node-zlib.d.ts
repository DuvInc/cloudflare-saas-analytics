/* The one Node API used (nodejs_compat), without pulling @types/node into the Worker. */
declare module "node:zlib" {
  export function gunzipSync(data: Uint8Array): { toString(encoding: "utf8"): string };
  export const constants: { BROTLI_PARAM_QUALITY: number };
  export function brotliCompressSync(data: Uint8Array, options: { params: Record<number, number> }): Uint8Array;
  export function brotliDecompressSync(data: Uint8Array): { toString(encoding: "utf8"): string };
}
