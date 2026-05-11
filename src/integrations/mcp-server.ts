import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ClawPayer } from "../core/clawpay.js";

/**
 * ClawPayer MCP Server
 *
 * Exposes ClawPayer as a Model Context Protocol server.
 * Any MCP-compatible agent (Claude, Cursor, OpenClaw, etc.)
 * can connect to this and request card details for payments.
 *
 * The agent doesn't get card info unless the policy says so.
 * That's the whole point.
 */

const server = new Server(
  {
    name: "clawpayer",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

let clawpayer: ClawPayer;

// --- Tool Definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "request_card",
        description: `Request stored credit card details to complete a payment.
The card will ONLY be returned if the payment passes the user's policy rules.
Depending on the amount and configuration, the payment may be auto-approved,
require human approval, or be denied outright.

IMPORTANT: Always call this BEFORE attempting to fill in any payment form.
The user has configured spending rules and must approve payments above certain thresholds.`,
        inputSchema: {
          type: "object" as const,
          properties: {
            amount: {
              type: "number",
              description:
                "The total payment amount (including tax/shipping if applicable)",
            },
            merchant: {
              type: "string",
              description:
                "The merchant name or website domain (e.g., 'amazon.com', 'Cool Store')",
            },
            description: {
              type: "string",
              description:
                "Brief description of what is being purchased (e.g., '2x t-shirts, 1x hoodie')",
            },
            currency: {
              type: "string",
              description: "Currency code (default: USD)",
              default: "USD",
            },
            agent_id: {
              type: "string",
              description: "Identifier for this agent instance (used for per-agent spending limits configured by the user)",
            },
          },
          required: ["amount", "merchant", "description"],
        },
      },
      {
        name: "get_payment_policy",
        description: `Get the user's payment policy configuration.
Call this to understand spending limits and rules BEFORE attempting a purchase.
This helps you know in advance whether a payment will be approved, need human
approval, or be blocked — so you can inform the user proactively.`,
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "check_card_status",
        description:
          "Check if a credit card is stored in the vault. Does not return card details.",
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      },
    ],
  };
});

// --- Tool Execution ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "request_card": {
      const { amount, merchant, description, currency, agent_id } = args as {
        amount: number;
        merchant: string;
        description: string;
        currency?: string;
        agent_id?: string;
      };

      const agentId = agent_id ?? process.env.CLAWPAYER_AGENT_ID;

      const result = await clawpayer.requestCard({
        amount,
        merchant,
        description,
        currency,
        agentId,
      });

      if (result.approved) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                approved: true,
                cardholderName: result.card.cardholderName,
                number: result.card.number,
                expMonth: result.card.expMonth,
                expYear: result.card.expYear,
                cvv: result.card.cvv,
                billingAddress: result.card.billingAddress,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              approved: false,
              reason: result.reason,
            }),
          },
        ],
      };
    }

    case "get_payment_policy": {
      const policy = clawpayer.getPolicy();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              autoApproveUnder: policy.autoApproveUnder,
              requireApprovalAbove: policy.requireApprovalAbove,
              blockAbove: policy.blockAbove,
              dailyLimit: policy.dailyLimit,
              monthlyLimit: policy.monthlyLimit,
              currency: policy.currency,
              blockedMerchants: policy.blockedMerchants,
              note: "Amounts at or below autoApproveUnder will return card details immediately. Amounts above requireApprovalAbove will trigger human approval. Amounts above blockAbove will be denied.",
            }),
          },
        ],
      };
    }

    case "check_card_status": {
      const hasCard = await clawpayer.hasCard();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              cardStored: hasCard,
              message: hasCard
                ? "A card is stored and ready to use."
                : "No card stored. The user needs to run `clawpayer add-card` first.",
            }),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Start ---

async function main() {
  clawpayer = await ClawPayer.load();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🦞 ClawPayer MCP server running on stdio");
}

main().catch((err) => {
  console.error("Failed to start ClawPayer MCP server:", err);
  process.exit(1);
});
