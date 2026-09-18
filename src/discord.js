import { config } from "./config.js";

function formatDateTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo"
  }).format(new Date(value));
}

function batteryLabel(value) {
  return Number.isFinite(value) ? `${value}%` : "API取得不可";
}

function discordValue(value, fallback = "未記入", maxLength = 1024) {
  const text = String(value || fallback).trim() || fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function roomName(rooms) {
  return (Array.isArray(rooms) ? rooms : [rooms])
    .filter(Boolean)
    .map((room) => room.name)
    .join("、") || "施設未設定";
}

function adminReservationUrl(reservation) {
  return `${config.baseUrl}/admin/reservations/${reservation.id}`;
}

function organizationMypageUrl() {
  return `${config.baseUrl}/mypage`;
}

function adminButton(reservation) {
  return [{
    type: 1,
    components: [{ type: 2, style: 5, label: "管理画面で確認", url: adminReservationUrl(reservation) }]
  }];
}

export function formatBatterySummary(statuses = []) {
  return statuses
    .map((status) => `${status.roomName}: Keypad ${batteryLabel(status.keypadBattery)} / Lock ${batteryLabel(status.lockBattery)}`)
    .join("\n");
}

export function makeAdminApplicationPayload(reservation, rooms, batteryStatuses = []) {
  const facility = roomName(rooms);
  const batterySummary = formatBatterySummary(batteryStatuses);
  return {
    content: "新しい施設予約申請が届きました。",
    embeds: [{
      title: `${facility}の予約申請`,
      color: 0x2563eb,
      url: adminReservationUrl(reservation),
      fields: [
        { name: "団体", value: discordValue(reservation.organizationName), inline: true },
        { name: "代表者", value: discordValue(reservation.representativeName), inline: true },
        { name: "連絡先", value: discordValue(reservation.contact), inline: false },
        { name: "施設", value: facility, inline: false },
        { name: "開始", value: formatDateTime(reservation.startsAt), inline: true },
        { name: "終了", value: formatDateTime(reservation.endsAt), inline: true },
        { name: "用途", value: discordValue(reservation.purpose), inline: false },
        ...(batterySummary ? [{ name: "SwitchBotバッテリー", value: discordValue(batterySummary), inline: false }] : [])
      ]
    }],
    components: adminButton(reservation)
  };
}

const adminStatusPresentation = {
  approved: { content: "施設予約を承認しました。", title: "予約承認", color: 0x16a34a },
  rejected: { content: "施設予約を却下しました。", title: "予約却下", color: 0xdc2626 },
  cancelled: { content: "施設予約をキャンセルしました。", title: "予約キャンセル", color: 0xd97706 },
  issuing_failed: { content: "SwitchBot暗証番号の発行に失敗しました。", title: "暗証番号発行エラー", color: 0xdc2626 },
  cancel_failed: { content: "SwitchBot暗証番号の削除に失敗しました。", title: "暗証番号削除エラー", color: 0xdc2626 }
};

export function makeAdminStatusPayload(reservation, rooms, {
  status,
  comment = "",
  warning = "",
  batteryStatuses = []
} = {}) {
  const presentation = adminStatusPresentation[status] || {
    content: "施設予約の状態が更新されました。",
    title: "予約状態更新",
    color: 0x475467
  };
  const facility = roomName(rooms);
  const batterySummary = formatBatterySummary(batteryStatuses);
  const fields = [
    { name: "団体", value: discordValue(reservation.organizationName), inline: true },
    { name: "施設", value: facility, inline: true },
    { name: "開始", value: formatDateTime(reservation.startsAt), inline: true },
    { name: "終了", value: formatDateTime(reservation.endsAt), inline: true },
    ...(comment ? [{ name: status === "rejected" ? "却下理由" : "管理者コメント", value: discordValue(comment), inline: false }] : []),
    ...(warning ? [{ name: "要確認", value: discordValue(warning), inline: false }] : []),
    ...(batterySummary ? [{ name: "SwitchBotバッテリー", value: discordValue(batterySummary), inline: false }] : [])
  ];

  return {
    content: presentation.content,
    embeds: [{
      title: `${facility}の${presentation.title}`,
      color: presentation.color,
      url: adminReservationUrl(reservation),
      fields
    }],
    components: adminButton(reservation)
  };
}

export function makeOrganizationApprovalPayload(reservation, rooms, batteryStatuses = []) {
  const facility = roomName(rooms);
  const batterySummary = formatBatterySummary(batteryStatuses);
  const mypageUrl = organizationMypageUrl();
  return {
    content: `【${discordValue(reservation.organizationName)}】施設予約が承認されました。暗証番号は団体マイページで確認してください。`,
    embeds: [{
      title: `${facility}の予約承認`,
      color: 0x16a34a,
      url: mypageUrl,
      fields: [
        { name: "団体", value: discordValue(reservation.organizationName), inline: true },
        { name: "施設", value: facility, inline: true },
        { name: "開始", value: formatDateTime(reservation.startsAt), inline: true },
        { name: "終了", value: formatDateTime(reservation.endsAt), inline: true },
        ...(batterySummary ? [{ name: "SwitchBotバッテリー", value: discordValue(batterySummary), inline: false }] : []),
        { name: "予約・暗証番号", value: `[団体マイページを開く](${mypageUrl})`, inline: false }
      ]
    }],
    components: [{
      type: 1,
      components: [{ type: 2, style: 5, label: "マイページで確認", url: mypageUrl }]
    }]
  };
}

// 既存のテストや内部呼び出しとの互換用エイリアスです。
export const makeApprovalDiscordPayload = makeOrganizationApprovalPayload;

export function makeOrganizationCancellationPayload(reservation, rooms) {
  const facility = roomName(rooms);
  return {
    content: `【${discordValue(reservation.organizationName)}】施設予約がキャンセルされました。`,
    embeds: [{
      title: `${facility}の予約キャンセル`,
      color: 0xd97706,
      fields: [
        { name: "団体", value: discordValue(reservation.organizationName), inline: true },
        { name: "施設", value: facility, inline: true },
        { name: "開始", value: formatDateTime(reservation.startsAt), inline: true },
        { name: "終了", value: formatDateTime(reservation.endsAt), inline: true }
      ]
    }]
  };
}

export function makeOrganizationRejectionPayload(reservation, rooms) {
  const facility = roomName(rooms);
  return {
    content: `【${discordValue(reservation.organizationName)}】施設予約が却下されました。詳細は団体マイページで確認してください。`,
    embeds: [{
      title: `${facility}の予約却下`,
      color: 0xdc2626,
      fields: [
        { name: "団体", value: discordValue(reservation.organizationName), inline: true },
        { name: "施設", value: facility, inline: true },
        { name: "開始", value: formatDateTime(reservation.startsAt), inline: true },
        { name: "終了", value: formatDateTime(reservation.endsAt), inline: true }
      ]
    }],
    components: [{
      type: 1,
      components: [{ type: 2, style: 5, label: "マイページで確認", url: `${config.baseUrl}/mypage` }]
    }]
  };
}

export async function postDiscordWebhook(webhookUrl, payload, {
  audience = "unknown",
  fetchImpl = fetch
} = {}) {
  if (!webhookUrl) return { skipped: true };
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Discord ${audience} notification failed (${response.status}).`);
  return { ok: true };
}

export function notifyDiscordAdminApplication(reservation, rooms, batteryStatuses = [], options = {}) {
  return postDiscordWebhook(
    options.webhookUrl ?? config.discordAdminWebhookUrl,
    makeAdminApplicationPayload(reservation, rooms, batteryStatuses),
    { audience: "admin", fetchImpl: options.fetchImpl }
  );
}

export function notifyDiscordAdminStatus(reservation, rooms, details, options = {}) {
  return postDiscordWebhook(
    options.webhookUrl ?? config.discordAdminWebhookUrl,
    makeAdminStatusPayload(reservation, rooms, details),
    { audience: "admin", fetchImpl: options.fetchImpl }
  );
}

export function notifyDiscordOrganizationApproval(reservation, rooms, batteryStatuses = [], options = {}) {
  return postDiscordWebhook(
    options.webhookUrl ?? config.discordOrganizationWebhookUrl,
    makeOrganizationApprovalPayload(reservation, rooms, batteryStatuses),
    { audience: "organization", fetchImpl: options.fetchImpl }
  );
}

export function notifyDiscordOrganizationCancellation(reservation, rooms, options = {}) {
  return postDiscordWebhook(
    options.webhookUrl ?? config.discordOrganizationWebhookUrl,
    makeOrganizationCancellationPayload(reservation, rooms),
    { audience: "organization", fetchImpl: options.fetchImpl }
  );
}

export function notifyDiscordOrganizationRejection(reservation, rooms, options = {}) {
  return postDiscordWebhook(
    options.webhookUrl ?? config.discordOrganizationWebhookUrl,
    makeOrganizationRejectionPayload(reservation, rooms),
    { audience: "organization", fetchImpl: options.fetchImpl }
  );
}

export async function deliverDiscordNotifications(notifications = []) {
  const results = [];
  for (const notification of notifications) {
    try {
      const result = await notification.send();
      results.push({
        audience: notification.audience,
        event: notification.event,
        status: result?.skipped ? "skipped" : "ok"
      });
    } catch (error) {
      results.push({
        audience: notification.audience,
        event: notification.event,
        status: "failed",
        message: error.message
      });
    }
  }
  return results;
}
