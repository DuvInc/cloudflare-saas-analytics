/*
  Your product definitions, bundled with the Worker. For each product add two files and import them
  here: config/events/<product>.json (the event catalog: names the health check will not flag, and
  the activation event) and config/funnels/<product>.json (the funnels). The products themselves
  (id, domain, collect host, currency) live in wrangler.jsonc `vars.PRODUCTS`.
*/
import exampleEvents from "./events/example-app.json";
import exampleFunnels from "./funnels/example-app.json";

export const eventCatalogs: { product: string; activation?: string; events: Record<string, string> }[] = [exampleEvents];

export const funnelFiles: { product: string; funnels: { id: string; name: string; description: string; steps: { kind: string; value: string }[]; unavailable?: string }[] }[] = [exampleFunnels];
