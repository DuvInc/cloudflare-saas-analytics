/*
  The funnels, defined in code: config/funnels/<product>.json, edited by you or your coding agent
  ("add a funnel from the blog to sign-up"), never in the dashboard. A step is a page view (a path
  where a star matches anything: "/jobs/STAR", "STAR/workshops/STAR", a star alone for any page) or an event.
*/
import { funnelFiles } from "../config";
import type { Step } from "./journeys";

export type FunnelDef = { id: string; product: string; name: string; description: string; steps: Step[]; unavailable?: string };

export const funnels: FunnelDef[] = funnelFiles.flatMap((f) =>
  f.funnels.map((x) => ({ ...x, product: f.product, steps: x.steps as Step[] })));
