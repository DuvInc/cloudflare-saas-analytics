/*
  The products Cloudflare SaaS Analytics serves. One entry per product, in wrangler.jsonc `vars.PRODUCTS`.

  - `domain`: the registrable domain. Every page host must be it or one of its subdomains, and
    the consent cookie `csa_id` is set on it, so it follows the visitor from the site to the app.
  - `collect`: the host this Worker answers on for that product (custom domain, `t.<domain>`).
  - `replay`: session replay for signed-in users; `replayDailyCap` bounds a runaway.
  - `currency`: the currency revenue is summed in (payments in another currency are kept, not summed).
*/
export type Product = {
  id: string;
  name: string;
  domain: string;
  collect: string;
  replay: boolean;
  replayDailyCap: number;
  currency: string;
  /** Extra hosts allowed outside `domain` (e.g. a docs site on another domain). */
  extraHosts?: string[];
};

let cache: { raw: string; list: Product[] } | null = null;

export function products(input: string | unknown[]): Product[] {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  if (cache?.raw === raw) return cache.list;
  const list = (JSON.parse(raw) as Product[]).map((p) => ({ ...p, extraHosts: p.extraHosts ?? [] }));
  cache = { raw, list };
  return list;
}

export const productById = (raw: string | unknown[], id: string) => products(raw).find((p) => p.id === id) ?? null;
export const productByCollectHost = (raw: string | unknown[], host: string) => products(raw).find((p) => p.collect === host) ?? null;

/** Is `host` one of the product's pages? Exact domain, a subdomain of it, or an extra host. */
export function ownsHost(p: Product, host: string): boolean {
  const h = host.toLowerCase();
  return h === p.domain || h.endsWith(`.${p.domain}`) || (p.extraHosts ?? []).includes(h);
}
