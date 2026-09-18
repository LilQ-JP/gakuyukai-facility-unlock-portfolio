import test from "node:test";
import assert from "node:assert/strict";
import {
  deliverDiscordNotifications,
  formatBatterySummary,
  makeAdminApplicationPayload,
  makeAdminStatusPayload,
  makeOrganizationApprovalPayload,
  makeOrganizationCancellationPayload,
  makeOrganizationRejectionPayload,
  notifyDiscordAdminApplication,
  notifyDiscordOrganizationApproval,
  notifyDiscordOrganizationRejection,
  postDiscordWebhook
} from "../src/discord.js";
import {
  resolveDiscordAdminWebhookUrl,
  resolveDiscordOrganizationWebhookUrl
} from "../src/config.js";

const reservation = {
  id: "res_test",
  publicToken: "public_test",
  organizationName: "テスト団体",
  representativeName: "テスト代表",
  contact: "private@example.test",
  purpose: "定例会議",
  rejectionComment: "公開しない却下理由",
  cancelComment: "公開しない取消理由",
  startsAt: "2026-07-16T01:00:00.000Z",
  endsAt: "2026-07-16T02:00:00.000Z"
};
const rooms = [{ name: "会議室1" }];
const batteries = [{ roomName: "会議室1", keypadBattery: null, lockBattery: 78 }];

test("formatBatterySummary formats available and unavailable battery levels", () => {
  assert.equal(
    formatBatterySummary(batteries),
    "会議室1: Keypad API取得不可 / Lock 78%"
  );
});

test("admin application includes private application details and a login-protected URL without token", () => {
  const payload = makeAdminApplicationPayload(reservation, rooms, batteries);
  const serialized = JSON.stringify(payload);
  const adminUrl = payload.components[0].components[0].url;

  assert.equal(serialized.includes(reservation.contact), true);
  assert.equal(serialized.includes(reservation.purpose), true);
  assert.equal(adminUrl.endsWith("/admin/reservations/res_test"), true);
  assert.equal(adminUrl.includes("token="), false);
  assert.equal(serialized.includes("public_test"), false);
});

test("organization approval links to mypage and excludes private or administrative data", () => {
  const payload = makeOrganizationApprovalPayload(reservation, rooms, batteries);
  const serialized = JSON.stringify(payload);

  assert.equal(payload.components[0].components[0].url.endsWith("/mypage"), true);
  assert.equal(payload.embeds[0].url.endsWith("/mypage"), true);
  assert.equal(payload.embeds[0].fields.at(-1).value.includes("/mypage"), true);
  assert.equal(serialized.includes("テスト団体"), true);
  assert.equal(serialized.includes("会議室1"), true);
  assert.equal(serialized.includes(reservation.contact), false);
  assert.equal(serialized.includes(reservation.purpose), false);
  assert.equal(serialized.includes(reservation.rejectionComment), false);
  assert.equal(serialized.includes("/admin/"), false);
  assert.equal(serialized.includes("token="), false);
  assert.equal(serialized.includes("123456"), false);
  assert.equal(serialized.includes("passcode"), false);
});

test("organization cancellation excludes cancellation reason, warnings and admin links", () => {
  const payload = makeOrganizationCancellationPayload({
    ...reservation,
    cancelWarning: "内部の手動削除警告"
  }, rooms);
  const serialized = JSON.stringify(payload);

  assert.equal(serialized.includes("キャンセルされました"), true);
  assert.equal(serialized.includes(reservation.cancelComment), false);
  assert.equal(serialized.includes("内部の手動削除警告"), false);
  assert.equal(serialized.includes("/admin/"), false);
});

test("organization rejection announces the result without private rejection details", () => {
  const payload = makeOrganizationRejectionPayload(reservation, rooms);
  const serialized = JSON.stringify(payload);

  assert.equal(serialized.includes("却下されました"), true);
  assert.equal(serialized.includes("テスト団体"), true);
  assert.equal(serialized.includes("会議室1"), true);
  assert.equal(payload.components[0].components[0].url.endsWith("/mypage"), true);
  assert.equal(serialized.includes(reservation.rejectionComment), false);
  assert.equal(serialized.includes(reservation.contact), false);
  assert.equal(serialized.includes(reservation.purpose), false);
  assert.equal(serialized.includes("/admin/"), false);
  assert.equal(serialized.includes("token="), false);
});

test("admin status includes rejection reason while organization payloads cannot receive it", () => {
  const payload = makeAdminStatusPayload(reservation, rooms, {
    status: "rejected",
    comment: reservation.rejectionComment
  });
  assert.equal(JSON.stringify(payload).includes(reservation.rejectionComment), true);
});

test("webhook configuration uses separate URLs and legacy URL only as organization fallback", () => {
  const env = {
    DISCORD_ADMIN_WEBHOOK_URL: "https://admin.example.test/webhook",
    DISCORD_ORGANIZATION_WEBHOOK_URL: "https://organization.example.test/webhook",
    DISCORD_WEBHOOK_URL: "https://legacy.example.test/webhook"
  };
  assert.equal(resolveDiscordAdminWebhookUrl(env), env.DISCORD_ADMIN_WEBHOOK_URL);
  assert.equal(resolveDiscordOrganizationWebhookUrl(env), env.DISCORD_ORGANIZATION_WEBHOOK_URL);
  assert.equal(resolveDiscordAdminWebhookUrl({ DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL }), "");
  assert.equal(
    resolveDiscordOrganizationWebhookUrl({ DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL }),
    env.DISCORD_WEBHOOK_URL
  );
});

test("admin and organization notification functions send only to their supplied webhook", async () => {
  const calledUrls = [];
  const fetchImpl = async (url) => {
    calledUrls.push(url);
    return { ok: true, status: 204 };
  };

  await notifyDiscordAdminApplication(reservation, rooms, batteries, {
    webhookUrl: "https://admin.example.test/webhook",
    fetchImpl
  });
  await notifyDiscordOrganizationApproval(reservation, rooms, batteries, {
    webhookUrl: "https://organization.example.test/webhook",
    fetchImpl
  });
  await notifyDiscordOrganizationRejection(reservation, rooms, {
    webhookUrl: "https://organization.example.test/webhook",
    fetchImpl
  });

  assert.deepEqual(calledUrls, [
    "https://admin.example.test/webhook",
    "https://organization.example.test/webhook",
    "https://organization.example.test/webhook"
  ]);
});

test("delivery continues to the other channel when one webhook fails", async () => {
  let organizationCalled = false;
  const results = await deliverDiscordNotifications([
    {
      audience: "admin",
      event: "approved",
      send: async () => { throw new Error("admin unavailable"); }
    },
    {
      audience: "organization",
      event: "approved",
      send: async () => {
        organizationCalled = true;
        return { ok: true };
      }
    }
  ]);

  assert.equal(organizationCalled, true);
  assert.deepEqual(results.map((result) => result.status), ["failed", "ok"]);
});

test("missing webhook skips safely and response body is not exposed on errors", async () => {
  assert.deepEqual(await postDiscordWebhook("", { content: "test" }), { skipped: true });
  await assert.rejects(
    postDiscordWebhook("https://admin.example.test/webhook", { content: "test" }, {
      audience: "admin",
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => "sensitive body" })
    }),
    (error) => error.message === "Discord admin notification failed (500)."
  );
});
