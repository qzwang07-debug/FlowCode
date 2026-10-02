import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const roundUp = (usd: number) => Math.ceil(usd * 1e9) / 1e9;

export interface SpendAuthorization {
  reserve(worstCostUsd: number): Promise<{ settle(actualCostUsd: number | null): Promise<void> }>;
}
/** Batch authorization includes probes, failed requests and parallel AgentRuns.
 * Reserve BEFORE forwarding. Missing usage/crashes consume the entire reserve.
 * The exclusive process lease prevents two Eval invocations sharing a ceiling. */
export class PersistentSpendBudget implements SpendAuthorization {
  private spent = 0;
  private readonly pending = new Map<string, number>();
  private closed = false;
  private exceededReservation = false;
  private readonly lease: number;
  constructor(private readonly file: string, readonly limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error("Invalid total spend authorization.");
    mkdirSync(path.dirname(file), { recursive: true });
    this.lease = openSync(`${file}.lock`, "wx");
    try {
      if (existsSync(file)) for (const line of readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.limitUsd !== limitUsd || !Number.isFinite(record.amount) || record.amount < 0 || typeof record.id !== "string")
          throw new Error("Spend ledger authorization changed or is corrupt; do not silently reset it.");
        if (record.kind === "reserve" && !this.pending.has(record.id)) this.pending.set(record.id, record.amount);
        else if (record.kind === "settle" && this.pending.has(record.id)) {
          if (record.amount > this.pending.get(record.id)!) this.exceededReservation = true;
          this.pending.delete(record.id); this.spent = roundUp(this.spent + record.amount);
        }
        else throw new Error("Invalid spend ledger sequence.");
      }
    } catch (error) { closeSync(this.lease); unlinkSync(`${file}.lock`); throw error; }
  }
  view() { return { limitUsd: this.limitUsd, accountedUsd: this.spent,
    reservedUsd: [...this.pending.values()].reduce((n, value) => n + value, 0), unresolvedRequests: this.pending.size }; }
  async reserve(worstCostUsd: number) {
    worstCostUsd = roundUp(worstCostUsd);
    const held = this.view().reservedUsd;
    if (this.closed || this.exceededReservation || !Number.isFinite(worstCostUsd) || worstCostUsd < 0 || this.spent + held + worstCostUsd > this.limitUsd)
      throw new Error("Total authorized API spend exhausted; no request forwarded.");
    const id = randomUUID();
    appendFileSync(this.file, JSON.stringify({ kind: "reserve", id, amount: worstCostUsd, limitUsd: this.limitUsd }) + "\n");
    this.pending.set(id, worstCostUsd);
    let settled = false;
    return { settle: async (actualCostUsd: number | null) => {
      if (settled) return;
      if (this.closed || actualCostUsd !== null && (!Number.isFinite(actualCostUsd) || actualCostUsd < 0)) throw new Error("Invalid usage accounting.");
      // Do not release a reservation for a failed request with no usage receipt.
      const amount = roundUp(actualCostUsd ?? worstCostUsd);
      appendFileSync(this.file, JSON.stringify({ kind: "settle", id, amount, limitUsd: this.limitUsd }) + "\n");
      settled = true; this.pending.delete(id); this.spent = roundUp(this.spent + amount);
      if (amount > worstCostUsd) { this.exceededReservation = true; throw new Error("Provider usage exceeded its pre-authorized bound; further calls blocked."); }
    } };
  }
  close() { if (!this.closed) { this.closed = true; closeSync(this.lease); unlinkSync(`${this.file}.lock`); } }
}
