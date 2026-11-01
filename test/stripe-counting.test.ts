import { describe, expect, it } from "vitest";
import { ingest } from "../src/stripe";

/* D1 double that remembers inserted payments and answers the two lookups ingest makes. */
function db() {
  const rows = new Map<string, { id: string; kind: string; amount: number; email: string }>();
  const prepare = (sql: string) => {
    let args: any[] = [];
    const s: any = {
      bind(...a: any[]) { args = a; return s; },
      async first() {
        if (sql.includes("kind = 'checkout'")) {
          const [, amount] = args;
          return [...rows.values()].some((r) => r.kind === "checkout" && r.amount === amount) ? { x: 1 } : null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT OR REPLACE INTO payments")) rows.set(args[0], { id: args[0], kind: args[2], amount: args[3], email: args[7] });
        if (sql.startsWith("DELETE FROM payments")) rows.delete(args[0]);
        return { meta: { changes: 1 } };
      },
    };
    return s;
  };
  return { rows, env: { DB: { prepare } } as never };
}

const checkout = { id: "cs_1", mode: "payment", payment_status: "paid", amount_total: 920, currency: "eur", created: 1000, invoice: "in_1", customer_details: { email: "a@b.c" }, metadata: { pack_id: "custom_credits" } };
const invoice = { id: "in_1", amount_paid: 920, currency: "eur", created: 1010, customer_email: "a@b.c", customer: "cus_1", billing_reason: "manual" };

describe("stripe counting", () => {
  it("counts a one-off Checkout once, invoice after checkout", async () => {
    const { env, rows } = db();
    await ingest(env, "p", "checkout.session.completed", checkout, true);
    await ingest(env, "p", "invoice.paid", invoice, true);
    expect([...rows.keys()]).toEqual(["cs_1"]);
  });
  it("counts it once, invoice before checkout", async () => {
    const { env, rows } = db();
    await ingest(env, "p", "invoice.paid", { ...invoice, customer: null }, true);
    await ingest(env, "p", "checkout.session.completed", checkout, true);
    expect([...rows.keys()]).toEqual(["cs_1"]);
  });
  it("still counts a subscription invoice and a standalone one-off invoice", async () => {
    const { env, rows } = db();
    await ingest(env, "p", "invoice.paid", { ...invoice, id: "in_sub", parent: { subscription_details: { metadata: {} } } }, true);
    await ingest(env, "p", "invoice.paid", { ...invoice, id: "in_manual", amount_paid: 5000 }, true);
    expect([...rows.keys()].sort()).toEqual(["in_manual", "in_sub"]);
  });
  it("ignores a free Checkout", async () => {
    const { env, rows } = db();
    expect(await ingest(env, "p", "checkout.session.completed", { ...checkout, amount_total: 0 }, true)).toBe(false);
    expect(rows.size).toBe(0);
  });
});
