/* The event catalogs (config/events/<product>.json), bundled: the health check flags names outside them. */
import { eventCatalogs as all } from "../config";

const catalogs: Record<string, Set<string>> = Object.fromEntries(all.map((c) => [c.product, new Set(Object.keys(c.events))]));
export default catalogs;
export const activations: Record<string, string | undefined> = Object.fromEntries(all.map((c) => [c.product, c.activation]));
