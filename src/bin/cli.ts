#!/usr/bin/env node

import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { stringify as toYaml } from "yaml";
import { Vault } from "../core/vault.js";
import type { ClawPayerConfig, TransactionLog } from "../types/index.js";

const CLAWPAYER_DIR = join(homedir(), ".clawpayer");
const CONFIG_FILE = join(CLAWPAYER_DIR, "config.yaml");

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function init() {
  console.log("\n🦞 ClawPayer Setup\n");
  console.log("This will create your encrypted card vault and payment policies.\n");

  const vault = new Vault("keychain");
  await vault.init();
  console.log("✅ Vault initialized (encryption key generated)\n");

  if (!existsSync(CONFIG_FILE)) {
    const defaultConfig: ClawPayerConfig = {
      vault: {
        encryption: "aes-256-gcm",
        keyStorage: "keychain",
      },
      policies: {
        autoApproveUnder: 25.0,
        requireApprovalAbove: 25.0,
        blockAbove: 1000.0,
        dailyLimit: 200.0,
        monthlyLimit: 2000.0,
        blockedKeywords: [],
        currency: "USD",
      },
      approval: {
        method: "terminal",
        timeout: 300,
      },
      logging: {
        enabled: true,
        path: join(CLAWPAYER_DIR, "transactions.json"),
      },
    };

    await writeFile(CONFIG_FILE, toYaml(defaultConfig), {
      encoding: "utf-8",
      mode: 0o600,
    });
    console.log(`✅ Config created at ${CONFIG_FILE}`);
    console.log("   Edit this file to customize your payment policies.\n");
  } else {
    console.log(`ℹ️  Config already exists at ${CONFIG_FILE}\n`);
  }
}

async function addCard() {
  console.log("\n🦞 ClawPayer — Add Card\n");
  console.log("Your card details will be encrypted and stored locally.");
  console.log("They never leave this machine.\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const cardholderName = await ask(rl, "Cardholder name: ");
    const number = await ask(rl, "Card number: ");
    const expMonth = await ask(rl, "Expiry month (MM): ");
    const expYear = await ask(rl, "Expiry year (YY or YYYY): ");
    const cvv = await ask(rl, "CVV: ");

    console.log("\nBilling address (leave blank to skip):");
    const line1 = await ask(rl, "  Address line 1: ");

    const billingAddress = line1
      ? {
          line1,
          line2: await ask(rl, "  Address line 2: "),
          city: await ask(rl, "  City: "),
          state: await ask(rl, "  State: "),
          postalCode: await ask(rl, "  Postal code: "),
          country: await ask(rl, "  Country (e.g., US): "),
        }
      : undefined;

    const vault = new Vault("keychain");
    await vault.storeCard({
      cardholderName,
      number: number.replace(/\s/g, ""),
      expMonth,
      expYear,
      cvv,
      billingAddress: billingAddress?.line1 ? billingAddress : undefined,
    });

    console.log("\n✅ Card encrypted and stored.");
    console.log("   Your agents can now request it through ClawPayer.\n");
  } finally {
    rl.close();
  }
}

async function status() {
  console.log("\n🦞 ClawPayer Status\n");

  const vault = new Vault("keychain");
  const hasCard = await vault.hasCard();
  const isLocked = existsSync(join(CLAWPAYER_DIR, "LOCKED"));

  console.log(`Vault:  ${hasCard ? "✅ Card stored" : "❌ No card stored"}`);
  console.log(`Config: ${existsSync(CONFIG_FILE) ? "✅ Found" : "❌ Not found"}`);
  console.log(`Lock:   ${isLocked ? "🔒 LOCKED (all payments blocked)" : "🔓 Unlocked"}`);
  console.log(`Dir:    ${CLAWPAYER_DIR}\n`);
}

async function lock() {
  const lockFile = join(CLAWPAYER_DIR, "LOCKED");
  await writeFile(lockFile, new Date().toISOString(), { encoding: "utf-8", mode: 0o600 });
  console.log("\n🔒 ClawPayer LOCKED — all payments blocked.\n");
  console.log("   Run `clawpayer unlock` to resume.\n");
}

async function unlock() {
  const lockFile = join(CLAWPAYER_DIR, "LOCKED");
  if (!existsSync(lockFile)) {
    console.log("\nℹ️  ClawPayer is not locked.\n");
    return;
  }
  const { unlink } = await import("node:fs/promises");
  await unlink(lockFile);
  console.log("\n🔓 ClawPayer UNLOCKED — payments resumed.\n");
}

async function audit() {
  const args = process.argv.slice(3);
  let fromDate: Date | undefined;
  let toDate: Date | undefined;
  let format = "json";
  let outFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from") fromDate = new Date(args[++i]);
    if (args[i] === "--to")   toDate   = new Date(args[++i]);
    if (args[i] === "--format") format = args[++i];
    if (args[i] === "--out")  outFile  = args[++i];
  }

  const LOG_FILE = join(CLAWPAYER_DIR, "transactions.json");
  if (!existsSync(LOG_FILE)) {
    console.log("\nNo transactions found.\n");
    return;
  }

  const allLogs: TransactionLog[] = JSON.parse(await readFile(LOG_FILE, "utf-8"));

  const filtered = allLogs.filter((l) => {
    if (fromDate && l.timestamp < fromDate.getTime()) return false;
    if (toDate   && l.timestamp > toDate.getTime())   return false;
    return true;
  });

  const approved      = filtered.filter((l) => l.approved);
  const denied        = filtered.filter((l) => !l.approved);
  const humanOversight = filtered.filter((l) => l.approvedBy === "human");

  const transactions = filtered.map((l) => ({
    id:             l.id,
    timestamp:      new Date(l.timestamp).toISOString(),
    agentId:        l.payment.agentId ?? "unknown",
    payment: {
      amount:      l.payment.amount,
      merchant:    l.payment.merchant,
      description: l.payment.description,
      currency:    l.payment.currency ?? "USD",
    },
    policyDecision: l.policyResult.action,
    policyReason:   l.policyResult.reason,
    approved:       l.approved,
    oversight:      l.approvedBy,
  }));

  const integrityHash =
    "sha256:" + createHash("sha256").update(JSON.stringify(transactions)).digest("hex");

  const report = {
    auditVersion: "1.0",
    exportedAt:   new Date().toISOString(),
    tool:         "ClawPayer",
    compliance:   "EU AI Act Article 26",
    period: {
      from: fromDate?.toISOString() ?? "all",
      to:   toDate?.toISOString()   ?? "all",
    },
    summary: {
      totalRequests:  filtered.length,
      approved:       approved.length,
      denied:         denied.length,
      humanOversight: humanOversight.length,
      autoApproved:   approved.filter((l) => l.approvedBy === "auto").length,
      totalSpend:     approved.reduce((s, l) => s + l.payment.amount, 0),
    },
    integrityHash,
    transactions,
  };

  let output: string;
  if (format === "csv") {
    const header = "id,timestamp,agentId,amount,merchant,description,currency,decision,approved,oversight";
    const rows = transactions.map((t) =>
      `${t.id},${t.timestamp},${t.agentId},${t.payment.amount},"${t.payment.merchant}","${t.payment.description}",${t.payment.currency},${t.policyDecision},${t.approved},${t.oversight}`
    );
    output = [header, ...rows].join("\n");
  } else {
    output = JSON.stringify(report, null, 2);
  }

  if (outFile) {
    await writeFile(outFile, output, "utf-8");
    console.log(`\n✅ Audit report saved to ${outFile}`);
    console.log(`   ${filtered.length} transactions | ${integrityHash}\n`);
  } else {
    console.log(output);
  }
}

// --- CLI Router ---

const command = process.argv[2];

switch (command) {
  case "init":
    init().catch(console.error);
    break;
  case "add-card":
    addCard().catch(console.error);
    break;
  case "status":
    status().catch(console.error);
    break;
  case "lock":
    lock().catch(console.error);
    break;
  case "unlock":
    unlock().catch(console.error);
    break;
  case "audit":
    audit().catch(console.error);
    break;
  default:
    console.log(`
🦞 ClawPayer — Payment gateway for AI agents

Usage:
  clawpayer init        Initialize vault and create default config
  clawpayer add-card    Store a credit card in the encrypted vault
  clawpayer status      Check vault and config status
  clawpayer lock        Block all payments immediately (emergency freeze)
  clawpayer unlock      Resume payments after a lock
  clawpayer audit       Export EU AI Act compliant audit report
    --from YYYY-MM-DD   Filter from date
    --to   YYYY-MM-DD   Filter to date
    --format json|csv   Output format (default: json)
    --out  FILE         Save to file instead of stdout

MCP Server:
  clawpayer serve       Start the MCP server (stdio transport)

Config: ~/.clawpayer/config.yaml
    `);
}
