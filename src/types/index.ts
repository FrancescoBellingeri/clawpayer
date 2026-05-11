export interface CardDetails {
  cardholderName: string;
  number: string;
  expMonth: string;
  expYear: string;
  cvv: string;
  billingAddress?: BillingAddress;
}

export interface BillingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface EncryptedPayload {
  iv: string;
  authTag: string;
  data: string;
}

export interface PolicyConfig {
  autoApproveUnder: number;
  requireApprovalAbove: number;
  blockAbove: number;
  dailyLimit: number;
  monthlyLimit?: number;
  blockedKeywords: string[];
  allowedMerchants?: string[];
  blockedMerchants?: string[];
  currency: string;
  maxTransactionsPerWindow?: number;
  windowSeconds?: number;
}

export interface PaymentRequest {
  amount: number;
  merchant: string;
  description: string;
  currency?: string;
  metadata?: Record<string, string>;
}

export interface PolicyResult {
  action: "auto_approve" | "require_approval" | "deny";
  reason: string;
}

export interface ApprovalRequest {
  id: string;
  payment: PaymentRequest;
  policyResult: PolicyResult;
  timestamp: number;
}

export type ApprovalMethod = "terminal" | "webhook" | "slack" | "callback" | "telegram" | "whatsapp";

export interface ClawPayerConfig {
  vault: {
    encryption: "aes-256-gcm";
    keyStorage: "keychain" | "file" | "env";
  };
  policies: PolicyConfig;
  approval: {
    method: ApprovalMethod;
    timeout: number;
    webhookUrl?: string;
    slackWebhookUrl?: string;
    telegramBotToken?: string;
    telegramChatId?: string;
  };
  logging: {
    enabled: boolean;
    path: string;
  };
}

export interface TransactionLog {
  id: string;
  timestamp: number;
  payment: PaymentRequest;
  policyResult: PolicyResult;
  approved: boolean;
  approvedBy: "auto" | "human";
}
