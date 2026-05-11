import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type {
  PolicyConfig,
  PaymentRequest,
  PolicyResult,
  TransactionLog,
  ClawPayerConfig,
} from "../types/index.js";

const CLAWPAYER_DIR = join(homedir(), ".clawpayer");
const CONFIG_FILE = join(CLAWPAYER_DIR, "config.yaml");
const LOG_FILE = join(CLAWPAYER_DIR, "transactions.json");

const DEFAULT_POLICY: PolicyConfig = {
  autoApproveUnder: 25.0,
  requireApprovalAbove: 25.0,
  blockAbove: 1000.0,
  dailyLimit: 200.0,
  monthlyLimit: 2000.0,
  blockedKeywords: [],
  allowedMerchants: [],
  blockedMerchants: [],
  currency: "USD",
};

/**
 * PolicyEngine — the bouncer.
 *
 * Evaluates payment requests against user-defined rules.
 * Checks amount thresholds, daily/monthly limits, merchant
 * allow/block lists, and keyword filters.
 */
export class PolicyEngine {
  private policy: PolicyConfig;

  constructor(policy?: Partial<PolicyConfig>) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /**
   * Load policy from the config file.
   */
  static async fromConfig(): Promise<PolicyEngine> {
    if (!existsSync(CONFIG_FILE)) {
      return new PolicyEngine();
    }

    const raw = await readFile(CONFIG_FILE, "utf-8");
    const config: ClawPayerConfig = parseYaml(raw);
    return new PolicyEngine(config.policies);
  }

  /**
   * Evaluate a payment request against the policy.
   */
  async evaluate(request: PaymentRequest): Promise<PolicyResult> {
    const amount = request.amount;
    const currency = request.currency || this.policy.currency;

    // Check emergency lock
    if (existsSync(join(CLAWPAYER_DIR, "LOCKED"))) {
      return {
        action: "deny",
        reason: "ClawPayer is locked. Run `clawpayer unlock` to resume payments.",
      };
    }

    // Check time-based rules
    const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    if (this.policy.allowedDays?.length) {
      const today = new Date().getDay();
      if (!this.policy.allowedDays.includes(today)) {
        const allowed = this.policy.allowedDays.map((d) => DAY_NAMES[d]).join(", ");
        return {
          action: "deny",
          reason: `Payments not allowed today (allowed days: ${allowed})`,
        };
      }
    }
    if (this.policy.allowedHours) {
      const hour = new Date().getHours();
      const { start, end } = this.policy.allowedHours;
      if (hour < start || hour >= end) {
        return {
          action: "deny",
          reason: `Payments not allowed at this hour (allowed: ${start}:00–${end}:00 local time, current: ${hour}:00)`,
        };
      }
    }

    // Check hard block
    if (amount > this.policy.blockAbove) {
      return {
        action: "deny",
        reason: `Amount $${amount} exceeds maximum allowed ($${this.policy.blockAbove})`,
      };
    }

    // Check blocked merchants
    if (this.policy.blockedMerchants?.length) {
      const merchantLower = request.merchant.toLowerCase();
      const blocked = this.policy.blockedMerchants.find((m) =>
        merchantLower.includes(m.toLowerCase())
      );
      if (blocked) {
        return {
          action: "deny",
          reason: `Merchant "${request.merchant}" is blocked by policy`,
        };
      }
    }

    // Check allowed merchants (if whitelist is set, only those are allowed)
    if (this.policy.allowedMerchants?.length) {
      const merchantLower = request.merchant.toLowerCase();
      const allowed = this.policy.allowedMerchants.some((m) =>
        merchantLower.includes(m.toLowerCase())
      );
      if (!allowed) {
        return {
          action: "deny",
          reason: `Merchant "${request.merchant}" is not in the allowed list`,
        };
      }
    }

    // Check blocked keywords
    if (this.policy.blockedKeywords.length) {
      const descLower = request.description.toLowerCase();
      const merchantLower = request.merchant.toLowerCase();
      const hit = this.policy.blockedKeywords.find(
        (kw) =>
          descLower.includes(kw.toLowerCase()) ||
          merchantLower.includes(kw.toLowerCase())
      );
      if (hit) {
        return {
          action: "deny",
          reason: `Blocked keyword "${hit}" found in request`,
        };
      }
    }

    // Check velocity (burst prevention)
    if (this.policy.maxTransactionsPerWindow !== undefined) {
      const windowMs = (this.policy.windowSeconds ?? 60) * 1000;
      const windowStart = Date.now() - windowMs;
      const logs = await this.getTransactionLogs();
      const recentCount = logs.filter(
        (l) => l.approved && l.timestamp >= windowStart
      ).length;
      if (recentCount >= this.policy.maxTransactionsPerWindow) {
        return {
          action: "deny",
          reason: `Velocity limit: ${recentCount} transactions in last ${this.policy.windowSeconds ?? 60}s (max: ${this.policy.maxTransactionsPerWindow})`,
        };
      }
    }

    // Check daily limit
    const todaySpent = await this.getTodaySpending();
    if (todaySpent + amount > this.policy.dailyLimit) {
      return {
        action: "deny",
        reason: `Daily limit exceeded. Spent today: $${todaySpent.toFixed(2)}, limit: $${this.policy.dailyLimit}`,
      };
    }

    // Check monthly limit
    if (this.policy.monthlyLimit) {
      const monthSpent = await this.getMonthSpending();
      if (monthSpent + amount > this.policy.monthlyLimit) {
        return {
          action: "deny",
          reason: `Monthly limit exceeded. Spent this month: $${monthSpent.toFixed(2)}, limit: $${this.policy.monthlyLimit}`,
        };
      }
    }

    // Auto-approve if under threshold
    if (amount <= this.policy.autoApproveUnder) {
      return {
        action: "auto_approve",
        reason: `Amount $${amount} is under auto-approve threshold ($${this.policy.autoApproveUnder})`,
      };
    }

    // Require human approval
    return {
      action: "require_approval",
      reason: `Amount $${amount} requires human approval (threshold: $${this.policy.requireApprovalAbove})`,
    };
  }

  /**
   * Get current policy for agents to inspect.
   */
  getPolicy(): PolicyConfig {
    return { ...this.policy };
  }

  // --- Transaction Logging ---

  async logTransaction(log: TransactionLog): Promise<void> {
    const logs = await this.getTransactionLogs();
    logs.push(log);

    const { writeFile: wf } = await import("node:fs/promises");
    await wf(LOG_FILE, JSON.stringify(logs, null, 2), "utf-8");
  }

  private async getTransactionLogs(): Promise<TransactionLog[]> {
    if (!existsSync(LOG_FILE)) return [];
    const raw = await readFile(LOG_FILE, "utf-8");
    try {
      return JSON.parse(raw) as TransactionLog[];
    } catch {
      return [];
    }
  }

  private async getTodaySpending(): Promise<number> {
    const logs = await this.getTransactionLogs();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    return logs
      .filter(
        (l) =>
          l.approved &&
          l.timestamp >= startOfDay.getTime()
      )
      .reduce((sum, l) => sum + l.payment.amount, 0);
  }

  private async getMonthSpending(): Promise<number> {
    const logs = await this.getTransactionLogs();
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    return logs
      .filter(
        (l) =>
          l.approved &&
          l.timestamp >= startOfMonth.getTime()
      )
      .reduce((sum, l) => sum + l.payment.amount, 0);
  }
}
