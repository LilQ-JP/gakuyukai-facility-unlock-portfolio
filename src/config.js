import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadDotEnv() {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

export function resolveDiscordAdminWebhookUrl(env = process.env) {
  return env.DISCORD_ADMIN_WEBHOOK_URL || "";
}

export function resolveDiscordOrganizationWebhookUrl(env = process.env) {
  return env.DISCORD_ORGANIZATION_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL || "";
}

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 8787),
  baseUrl: process.env.BASE_URL || "http://localhost:8787",
  adminToken: process.env.ADMIN_TOKEN || "dev-admin-token",
  discordAdminWebhookUrl: resolveDiscordAdminWebhookUrl(),
  discordOrganizationWebhookUrl: resolveDiscordOrganizationWebhookUrl(),
  emailMode: process.env.EMAIL_MODE || "log",
  mailFrom: process.env.MAIL_FROM || "",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure: (process.env.SMTP_SECURE || "false") === "true",
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  switchbotToken: process.env.SWITCHBOT_TOKEN || "",
  switchbotSecret: process.env.SWITCHBOT_SECRET || "",
  switchbotMock: (process.env.SWITCHBOT_MOCK || "true") !== "false",
  startBufferMinutes: Number(process.env.PASSCODE_START_BUFFER_MINUTES || 10),
  endBufferMinutes: Number(process.env.PASSCODE_END_BUFFER_MINUTES || 10)
};
