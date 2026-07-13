import { JsonAiBillingService } from "../src/server/ai-billing";

const amountRmb = Number(process.argv[2]);
const maxUses = Number(process.argv[3] ?? 1);
const expiresAt = process.argv[4]?.trim() || undefined;

if (!Number.isFinite(amountRmb) || amountRmb <= 0) {
  throw new Error("Usage: npm run billing:create-code -- <amount-rmb> [max-uses] [expires-at-iso]");
}
if (!Number.isInteger(maxUses) || maxUses <= 0) throw new Error("max-uses must be a positive integer");
if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new Error("expires-at must be an ISO date");

const billing = new JsonAiBillingService();
const result = await billing.createRedemptionCode(Math.round(amountRmb * 1_000_000), { maxUses, expiresAt });
console.log(JSON.stringify({ ...result, amountRmb }, null, 2));
