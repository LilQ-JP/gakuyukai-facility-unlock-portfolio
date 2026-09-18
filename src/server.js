import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { config } from "./config.js";
import { parseJapanDateTimeLocal } from "./datetime.js";
import {
  deliverDiscordNotifications,
  notifyDiscordAdminApplication,
  notifyDiscordAdminStatus,
  notifyDiscordOrganizationApproval,
  notifyDiscordOrganizationCancellation,
  notifyDiscordOrganizationRejection
} from "./discord.js";
import {
  makeLoginEmail,
  makeReservationCreatedEmail,
  makeReservationStatusEmail,
  sendEmail
} from "./email.js";
import {
  createTemporaryPasscode,
  deleteTemporaryPasscode,
  getAllDeviceBatteryStatuses,
  getRoomBatteryStatuses,
  getSwitchBotDevices
} from "./switchbot.js";
import {
  findReservationForLockEvent,
  findRoomIdForLockDevice,
  parseSwitchBotLockEvent,
  syncRoomLockDeviceIds
} from "./switchbot-events.js";
import {
  addAuditLog,
  canOrganizationReserveRoom,
  FACILITY_ACCESS_ROLES,
  facilityAccessRole,
  getDb,
  hashToken,
  hashPassword,
  hasRoomConflict,
  isAnnualOrganizationResetDate,
  makeId,
  publicReservation,
  resetOrganizationsForAcademicYear,
  saveDb,
  verifyPassword
} from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

function send(res, status, body, headers = {}) {
  const isObject = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isObject ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    ...headers
  });
  res.end(isObject ? JSON.stringify(body) : body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const raw = await readRaw(req);
  return raw ? JSON.parse(raw) : {};
}

async function readBody(req) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) return readJson(req);
  const params = new URLSearchParams(await readRaw(req));
  const body = {};
  for (const [key, value] of params.entries()) {
    if (body[key]) body[key] = Array.isArray(body[key]) ? [...body[key], value] : [body[key], value];
    else body[key] = value;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadRoomBatteryStatuses(rooms, devicesRaw = null) {
  try {
    return await getRoomBatteryStatuses(rooms, devicesRaw);
  } catch {
    return [];
  }
}

async function notifyDiscordWithAudit(reservationId, notifications) {
  const results = await deliverDiscordNotifications(notifications);
  for (const result of results) {
    if (result.status === "skipped") continue;
    await addAuditLog(`discord.${result.audience}.${result.event}.${result.status}`, {
      reservationId,
      ...(result.message ? { message: result.message } : {})
    });
  }
  return results;
}

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

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(value.join("="));
  }
  return cookies;
}

async function getSessionOrg(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const db = await getDb();
  const now = Date.now();
  const session = db.sessions.find((item) => item.id === sid && new Date(item.expiresAt).getTime() > now);
  if (!session) return null;
  const organization = db.organizations.find((item) => item.id === session.organizationId);
  return organization ? { session, organization } : null;
}

function isAdminRequest(req) {
  const adminCookie = parseCookies(req).admin;
  return adminCookie === hashToken(config.adminToken);
}

function isAdminToken(token) {
  return Boolean(token && token === config.adminToken);
}

function page(title, body, sessionOrg = null, isAdmin = false) {
  const orgLinks = sessionOrg
    ? `<a href="/mypage">マイページ</a><a href="/logout">ログアウト</a>`
    : `<a href="/login">ログイン</a><a href="/register">団体登録</a>`;
  const adminLinks = isAdmin
    ? `<a href="/admin">管理</a><a href="/mailbox">メールログ</a><a href="/admin/logout">管理ログアウト</a>`
    : sessionOrg ? "" : `<a href="/admin/login">管理</a>`;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/"><strong>学友会施設予約</strong><span>一時解錠システム</span></a>
    <nav aria-label="メインメニュー">
      <a href="/reserve">予約申請</a>
      ${adminLinks}
      ${orgLinks}
    </nav>
  </header>
  ${body}
  <script src="/app.js" type="module"></script>
</body>
</html>`;
}

function adminLayout(title, body, { active = "dashboard", notificationCount = 0 } = {}) {
  const icons = {
    dashboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11 12 3l9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    pending: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 1-8.5 6M3 3v6h6M12 7v5l3 2"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3v3m14-3v3M3 9h18M4 5h16a1 1 0 0 1 1 1v14H3V6a1 1 0 0 1 1-1z"/></svg>',
    groups: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a5 5 0 0 1 10 0v2m2-15a3 3 0 0 1 0 6m1 4a5 5 0 0 1 5 5"/></svg>',
    rooms: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V4a1 1 0 0 1 1-1h11v18M4 21h16M9 12h.01M16 7h4v14"/></svg>',
    switchbot: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="4"/><path d="M8 8h8m-8 4h5m-5 4h3"/></svg>',
    history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M12 7v5l3 2"/></svg>',
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>'
  };
  const navLink = (key, label, href, { badge = "" } = {}) => `<a class="${key === active ? "active" : ""}" href="${href}" data-admin-nav-target="${href.startsWith("#") ? href.slice(1) : key}" ${key === active ? 'aria-current="page"' : ""}>
    <span class="admin-nav-icon">${icons[key]}</span><strong>${escapeHtml(label)}</strong>${badge ? `<em>${badge}</em>` : ""}
  </a>`;

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body class="admin-body">
  <header class="admin-topbar">
    <button class="admin-icon-button admin-menu-toggle" type="button" data-admin-menu-toggle aria-controls="admin-sidebar" aria-expanded="false" aria-label="管理メニューを開く">☰</button>
    <a class="admin-toolbar-title" href="/admin"><strong>管理コンソール</strong><span>ダッシュボード</span></a>
    <div class="admin-userbar">
      <a class="admin-notice admin-icon-button" href="#pending" aria-label="通知 ${notificationCount}件">${icons.pending}<span>${notificationCount}</span></a>
      <span class="admin-top-account"><strong>学友会本部</strong><small>管理者</small></span>
    </div>
  </header>
  <div class="admin-frame">
    <div class="admin-sidebar-backdrop" data-admin-sidebar-backdrop hidden></div>
    <aside class="admin-sidebar" id="admin-sidebar" aria-label="管理サイドバー">
      <div class="admin-sidebar-brand"><a href="/admin"><span>F</span><strong>Facility</strong></a><button type="button" data-admin-menu-close aria-label="管理メニューを閉じる">×</button></div>
      <div class="admin-profile"><span>学</span><div><strong>学友会本部</strong><small>システム管理者</small></div></div>
      <nav aria-label="管理メニュー">
        <p>運用</p>
        ${navLink("dashboard", "ダッシュボード", "/admin")}
        ${navLink("pending", "承認待ち", "#pending", { badge: notificationCount || "" })}
        ${navLink("calendar", "空き状況", "#availability")}
        ${navLink("calendar", "予約一覧", "#reservations")}
        ${navLink("groups", "団体一覧", "#requests")}
        <p>施設・機器</p>
        ${navLink("rooms", "施設設定", "#rooms")}
        <button class="admin-nav-button" type="button" data-switchbot-open data-admin-nav-target="switchbot">${icons.switchbot}<strong>SwitchBot</strong><span class="admin-nav-chevron">›</span></button>
        <p>システム</p>
        ${navLink("history", "履歴・ログ", "#usage")}
        ${navLink("mail", "メールログ", "/mailbox")}
      </nav>
      <a class="admin-sidebar-logout" href="/admin/logout">ログアウト</a>
    </aside>
    ${body}
  </div>
  <div class="switchbot-backdrop" data-switchbot-backdrop hidden></div>
  <aside class="switchbot-panel" data-switchbot-panel role="dialog" aria-modal="true" aria-labelledby="switchbot-panel-title" aria-hidden="true" tabindex="-1">
    <header class="switchbot-panel-head">
      <div><span class="eyebrow">DEVICE MONITOR</span><h2 id="switchbot-panel-title">SwitchBot</h2><p>全デバイスのバッテリーと施設紐付け</p></div>
      <button class="switchbot-close" type="button" data-switchbot-close aria-label="SwitchBotパネルを閉じる">×</button>
    </header>
    <div class="switchbot-panel-toolbar">
      <p data-switchbot-updated>パネルを開くと状態を取得します</p>
      <button class="button small" type="button" data-switchbot-refresh>状態を更新</button>
    </div>
    <div class="switchbot-sortbar">
      <label>並び替え
        <select data-switchbot-sort aria-label="SwitchBotの並び替え基準">
          <option value="battery">バッテリー残量</option>
          <option value="facility">施設名</option>
          <option value="name">機器名</option>
          <option value="type">機器の種類</option>
        </select>
      </label>
      <button class="button small switchbot-order" type="button" data-switchbot-order data-direction="asc" aria-label="残量が少ない順で表示">↑ 少ない順</button>
    </div>
    <div class="switchbot-summary" data-switchbot-summary aria-live="polite"></div>
    <div class="switchbot-content" data-switchbot-content><p class="switchbot-empty">読み込み前です。</p></div>
    <footer class="switchbot-panel-footer"><a href="#rooms" data-switchbot-settings-link>施設設定</a><a href="/admin/switchbot/devices">SwitchBot JSON</a></footer>
  </aside>
  <script src="/app.js" type="module"></script>
</body>
</html>`;
}

async function serveStatic(res, pathname) {
  const filePath = join(publicDir, pathname);
  try {
    const file = await readFile(filePath);
    const type = {
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".png": "image/png"
    }[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
    return true;
  } catch {
    return false;
  }
}

function statusLabel(status) {
  return {
    pending: "承認待ち",
    issuing: "発行処理中",
    approved: "承認済み",
    rejected: "却下",
    cancelled: "キャンセル済み",
    issuing_failed: "発行失敗",
    cancel_failed: "キャンセル失敗"
  }[status] || status;
}

function facilityAccessRoleLabel(organization) {
  return facilityAccessRole(organization) === "committee" ? "委員会" : "一般団体";
}

function restrictedRoomsForOrganization(organization, rooms) {
  return rooms.filter((room) => !canOrganizationReserveRoom(organization, room));
}

function roomNames(db, reservation) {
  const ids = Array.isArray(reservation.roomIds) ? reservation.roomIds : [reservation.roomId];
  return ids.map((id) => db.rooms.find((room) => room.id === id)?.name || id).join("、");
}

function selectedRoomIds(input) {
  const raw = input.roomIds || input.roomId;
  return [...new Set((Array.isArray(raw) ? raw : [raw]).filter(Boolean))];
}

function truncate(value, length = 42) {
  const text = String(value || "").trim();
  if (text.length <= length) return text;
  return `${text.slice(0, length)}...`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    timeZone: "Asia/Tokyo"
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo"
  }).format(new Date(value));
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function orderedRooms(db, { includeArchived = false, activeOnly = false } = {}) {
  return db.rooms
    .filter((room) => includeArchived || !room.archivedAt)
    .filter((room) => !activeOnly || room.active)
    .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0));
}

function formatDateInput(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInput(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return startOfToday();
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return formatDateInput(date) === value ? date : startOfToday();
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function sameLocalDate(a, b) {
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function roomList(db, reservation) {
  const ids = Array.isArray(reservation.roomIds) ? reservation.roomIds : [reservation.roomId];
  return ids.map((id) => db.rooms.find((room) => room.id === id)).filter(Boolean);
}

function statusTone(status) {
  if (["approved", "active", "deleted"].includes(status)) return "success";
  if (["pending", "issuing", "manual_required"].includes(status)) return "warning";
  if (["rejected", "issuing_failed", "cancel_failed", "failed"].includes(status)) return "danger";
  if (["cancelled"].includes(status)) return "muted";
  return "info";
}

function formatShortDateTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo"
  }).format(new Date(value));
}

function statusBadge(status) {
  return `<span class="chip ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function isMockPasscode(passcode) {
  return Boolean(passcode?.mock)
    || String(passcode?.commandId || "").startsWith("mock_")
    || String(passcode?.keyId || "").startsWith("mock_key_");
}

function reservationIdLabel(id) {
  return `#${String(id || "").replace(/^res_/, "").slice(0, 10)}`;
}

function renderAdminDayTimeline(db, date = startOfToday()) {
  const activeRooms = orderedRooms(db, { activeOnly: true });
  const dayStart = new Date(date);
  const dayEnd = addDays(dayStart, 1);
  const hours = [9, 12, 15, 18, 21];
  const reservations = db.reservations
    .filter((reservation) => {
      const start = new Date(reservation.startsAt).getTime();
      const end = new Date(reservation.endsAt).getTime();
      return start < dayEnd.getTime() && end > dayStart.getTime();
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  const hourMarkers = hours.map((hour) => `<span>${hour}:00</span>`).join("");
  const rows = activeRooms.map((room) => {
    const blocks = reservations
      .filter((reservation) => {
        const roomIds = Array.isArray(reservation.roomIds) ? reservation.roomIds : [reservation.roomId];
        return roomIds.includes(room.id);
      })
      .map((reservation) => {
        const start = new Date(reservation.startsAt);
        const end = new Date(reservation.endsAt);
        const startHour = start.getHours() + start.getMinutes() / 60;
        const endHour = end.getHours() + end.getMinutes() / 60;
        const left = Math.max(0, Math.min(100, ((startHour - 8) / 14) * 100));
        const width = Math.max(9, Math.min(100 - left, ((endHour - startHour) / 14) * 100));
        return `<a class="day-event ${escapeHtml(statusTone(reservation.status))}" style="left:${left}%;width:${width}%;" href="/admin/reservations/${reservation.id}">
          <strong>${escapeHtml(formatTime(reservation.startsAt))}〜${escapeHtml(formatTime(reservation.endsAt))}</strong>
          <span>${escapeHtml(reservation.organizationName)}</span>
        </a>`;
      })
      .join("");
    return `<div class="day-row">
      <div class="day-room"><strong>${escapeHtml(room.name)}</strong><span>${escapeHtml(room.id)}</span></div>
      <div class="day-lane">${blocks || "<span class='day-empty'>空き</span>"}</div>
    </div>`;
  }).join("");

  const mobileRows = activeRooms.map((room) => {
    const roomReservations = reservations.filter((reservation) => {
      const roomIds = Array.isArray(reservation.roomIds) ? reservation.roomIds : [reservation.roomId];
      return roomIds.includes(room.id);
    });
    const items = roomReservations
      .map((reservation) => `<a class="mobile-schedule-item ${escapeHtml(statusTone(reservation.status))}" href="/admin/reservations/${reservation.id}">
        <strong>${escapeHtml(formatTime(reservation.startsAt))}〜${escapeHtml(formatTime(reservation.endsAt))}</strong>
        <span>${escapeHtml(reservation.organizationName)}</span>
        <em>${escapeHtml(statusLabel(reservation.status))}</em>
      </a>`)
      .join("");
    return `<section class="mobile-room-schedule">
      <header><strong>${escapeHtml(room.name)}</strong><span>${escapeHtml(room.id)}</span></header>
      <div>${items || "<p class='mobile-schedule-empty'>予約なし</p>"}</div>
    </section>`;
  }).join("");

  const previousDate = formatDateInput(addDays(dayStart, -1));
  const nextDate = formatDateInput(addDays(dayStart, 1));
  const selectedDate = formatDateInput(dayStart);
  const roomSummary = activeRooms.map((room) => room.name).join("・") || "有効な施設なし";
  const nowLine = sameLocalDate(dayStart, startOfToday())
    ? `<div class="now-line" style="left:${Math.max(0, Math.min(100, (((new Date().getHours() + new Date().getMinutes() / 60) - 8) / 14) * 100))}%"><span>現在時刻</span></div>`
    : "";

  return `<section class="admin-card admin-span" id="availability">
    <div class="card-head">
      <div>
        <h2>施設の空き状況（${escapeHtml(formatDate(dayStart))}）</h2>
        <p>08:00〜22:00 / ${escapeHtml(roomSummary)}</p>
      </div>
      <div class="timeline-legend">
        <span><i class="legend-success"></i>承認済み</span>
        <span><i class="legend-warning"></i>承認待ち</span>
        <span><i class="legend-muted"></i>キャンセル</span>
      </div>
    </div>
    <div class="day-navigation" aria-label="空き状況の日付移動">
      <a class="button small" href="/admin?date=${previousDate}#availability" aria-label="前日を表示">← 前日</a>
      <form method="get" action="/admin#availability">
        <label><span>表示日</span><input type="date" name="date" value="${selectedDate}" aria-label="表示する日付"></label>
        <button class="button small" type="submit">表示</button>
      </form>
      <a class="button small" href="/admin#availability">今日</a>
      <a class="button small" href="/admin?date=${nextDate}#availability" aria-label="翌日を表示">翌日 →</a>
    </div>
    <div class="day-timeline day-timeline-desktop">
      <div class="day-scale"><span></span>${hourMarkers}</div>
      ${rows || `<p class="empty">有効な施設がありません。</p>`}
      ${nowLine}
    </div>
    <div class="day-mobile-list">${mobileRows || `<p class="empty">有効な施設がありません。</p>`}</div>
  </section>`;
}

function renderPasscodeLogRows(db, limit = 12) {
  return db.passcodes
    .map((passcode) => {
      const reservation = db.reservations.find((item) => item.id === passcode.reservationId);
      const room = db.rooms.find((item) => item.id === passcode.roomId);
      const failed = passcode.deleteStatus === "failed" || passcode.status === "failed";
      const deleted = Boolean(passcode.deletedAt || passcode.deleteStatus === "deleted");
      return {
        at: passcode.deletedAt || passcode.createdAt || reservation?.updatedAt || reservation?.createdAt,
        organizationName: reservation?.organizationName || "-",
        roomName: room?.name || passcode.roomId,
        operation: deleted ? "暗証番号削除" : "暗証番号発行",
        result: failed ? "失敗" : deleted ? "削除済み" : "発行済み",
        status: failed ? "failed" : "approved",
        note: passcode.warning || (passcode.keyId ? "SwitchBot反映済み" : "ID未取得")
      };
    })
    .filter((row) => row.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit)
    .map((row) => `<tr>
      <td data-label="日時">${escapeHtml(formatShortDateTime(row.at))}</td>
      <td data-label="団体名">${escapeHtml(row.organizationName)}</td>
      <td data-label="施設">${escapeHtml(row.roomName)}</td>
      <td data-label="操作">${escapeHtml(row.operation)}</td>
      <td data-label="結果"><span class="chip ${escapeHtml(row.status)}">${escapeHtml(row.result)}</span></td>
      <td data-label="備考">${escapeHtml(row.note)}</td>
    </tr>`)
    .join("");
}

function lockStateLabel(state) {
  return {
    LOCKED: "施錠",
    UNLOCKED: "解錠",
    JAMMED: "異常停止"
  }[state] || state;
}

function renderLockEventRows(db, limit = 25) {
  return (db.switchbotEvents || [])
    .slice()
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, limit)
    .map((event) => {
      const room = db.rooms.find((item) => item.id === event.roomId);
      const reservation = findReservationForLockEvent(db, event);
      const stateClass = event.lockState === "JAMMED"
        ? "failed"
        : event.lockState === "UNLOCKED" ? "approved" : "cancelled";
      const battery = Number.isFinite(event.battery) ? `${event.battery}%` : "取得不可";
      return `<tr>
        <td data-label="日時">${escapeHtml(formatShortDateTime(event.occurredAt))}</td>
        <td data-label="施設">${escapeHtml(room?.name || "未紐付け")}</td>
        <td data-label="状態"><span class="chip ${stateClass}">${escapeHtml(lockStateLabel(event.lockState))}</span></td>
        <td data-label="予約団体">${reservation ? `${escapeHtml(reservation.organizationName)}<small>予約時間から推定</small>` : "該当予約なし"}</td>
        <td data-label="電池">${escapeHtml(battery)}</td>
      </tr>`;
    })
    .join("");
}

function renderTimeline(db, { currentOrganizationId = null, admin = false } = {}) {
  const activeRooms = orderedRooms(db, { activeOnly: true });
  const days = Array.from({ length: 7 }, (_, index) => addDays(startOfToday(), index));
  const weekEnd = addDays(days[0], 7).getTime();
  const items = db.reservations
    .filter((reservation) => {
      if (["rejected", "cancelled"].includes(reservation.status)) return false;
      const start = new Date(reservation.startsAt).getTime();
      const end = new Date(reservation.endsAt).getTime();
      return start < weekEnd && end >= days[0].getTime();
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());

  const reservationsFor = (room, day) => items.filter((reservation) => {
    const reservationRoomIds = Array.isArray(reservation.roomIds) ? reservation.roomIds : [reservation.roomId];
    return reservationRoomIds.includes(room.id) && sameLocalDate(reservation.startsAt, day);
  });
  const renderItem = (reservation) => {
    const isOwn = Boolean(currentOrganizationId && reservation.organizationId === currentOrganizationId);
    if (!admin && !isOwn) {
      return `<div class="timeline-item reserved" aria-label="${escapeHtml(`${formatTime(reservation.startsAt)}-${formatTime(reservation.endsAt)} 予約あり`)}">
        <strong>${escapeHtml(formatTime(reservation.startsAt))}-${escapeHtml(formatTime(reservation.endsAt))}</strong>
        <span>予約あり</span>
        <em>詳細は予約団体のみ確認できます</em>
      </div>`;
    }
    const ownClass = isOwn ? " own" : "";
    const href = admin ? `/admin/reservations/${reservation.id}` : `/r/${reservation.publicToken}`;
    return `<a class="timeline-item ${escapeHtml(reservation.status)}${ownClass}" href="${href}">
      <strong>${escapeHtml(formatTime(reservation.startsAt))}-${escapeHtml(formatTime(reservation.endsAt))}</strong>
      <span>${escapeHtml(reservation.organizationName)}</span>
      <em>${escapeHtml(statusLabel(reservation.status))}</em>
    </a>`;
  };

  const header = days.map((day) => `<th>${escapeHtml(formatDate(day))}<small>08:00-22:00</small></th>`).join("");
  const rows = activeRooms.map((room) => {
    const cells = days.map((day) => {
      const chips = reservationsFor(room, day).map(renderItem).join("");
      return `<td>${chips || "<span class='timeline-empty'>空き</span>"}</td>`;
    }).join("");
    return `<tr><th class="timeline-room">${escapeHtml(room.name)}</th>${cells}</tr>`;
  }).join("");
  const dayTabs = days.map((day, index) => `<button class="timeline-day-button${index === 0 ? " active" : ""}" type="button" role="tab" aria-selected="${index === 0}" aria-controls="timeline-day-${index}" data-timeline-day-button="${index}">
    <strong>${escapeHtml(formatDate(day))}</strong><span>08:00-22:00</span>
  </button>`).join("");
  const mobileDays = days.map((day, index) => {
    const roomRows = activeRooms.map((room) => {
      const bookings = reservationsFor(room, day);
      return `<section class="timeline-mobile-room">
        <header><strong>${escapeHtml(room.name)}</strong><span>${bookings.length ? `${bookings.length}件` : "空き"}</span></header>
        <div>${bookings.map(renderItem).join("") || `<p class="timeline-mobile-empty">予約はありません</p>`}</div>
      </section>`;
    }).join("");
    return `<section class="timeline-mobile-day" id="timeline-day-${index}" role="tabpanel" data-timeline-day="${index}" ${index === 0 ? "" : "hidden"}>
      <h3>${escapeHtml(formatDate(day))}</h3>
      ${roomRows || `<p class="empty">有効な施設がありません。</p>`}
    </section>`;
  }).join("");

  return `<section class="panel timeline-panel">
    <div class="panel-title">
      <div>
        <h2>今週の予約タイムライン</h2>
        <p>表示時間帯は08:00-22:00です。</p>
      </div>
    </div>
    <div class="timeline-scroll">
      <table class="timeline-table">
        <thead><tr><th>施設</th>${header}</tr></thead>
        <tbody>${rows || `<tr><td colspan="8" class="empty">有効な施設がありません。</td></tr>`}</tbody>
      </table>
    </div>
    <div class="timeline-mobile">
      <div class="timeline-day-tabs" role="tablist" aria-label="表示する日付">${dayTabs}</div>
      <div class="timeline-mobile-days">${mobileDays}</div>
    </div>
  </section>`;
}

async function homePage(req) {
  const db = await getDb();
  const sessionOrg = await getSessionOrg(req);
  const pending = db.reservations.filter((item) => item.status === "pending").length;
  const approved = db.reservations.filter((item) => item.status === "approved").length;
  return page(
    "学友会施設予約・一時解錠システム",
    `<main class="shell">
      <section class="hero">
        <div>
          <h1>7号館施設利用者申請</h1>
          <p>団体登録後、マイページから申請できます。</p><br>
          <p>学友会が承認すると、予約時間だけ使えるSwitchBot一時暗証番号を発行します。</p>
          <div class="actions">
            <a class="button primary" href="${sessionOrg ? "/reserve" : "/register"}">${sessionOrg ? "予約申請をする" : "団体登録する"}</a>
            <a class="button" href="${sessionOrg ? "/mypage" : "/login"}">${sessionOrg ? "マイページを見る" : "ログインする"}</a>
          </div>
        </div>
        <div class="status-board">
          <div><span>登録団体</span><strong>${db.organizations.length}</strong></div>
          <div><span>承認待ち</span><strong>${pending}</strong></div>
          <div><span>承認済み</span><strong>${approved}</strong></div>
          <div><span>部屋数</span><strong>${orderedRooms(db, { activeOnly: true }).length}</strong></div>
        </div>
      </section>
    </main>`,
    sessionOrg
  );
}

async function registerPage(req) {
  const sessionOrg = await getSessionOrg(req);
  return page(
    "団体登録",
    `<main class="shell narrow">
      <section>
        <h1>団体登録</h1>
        <p>団体アドレスまたは学生アドレスと、団体で共有するパスワードを登録します。</p>
        <form class="panel form single" method="post" action="/auth/register">
          <label>団体名<input name="name" required autocomplete="organization"></label>
          <label>代表者名<input name="representativeName" required autocomplete="name"></label>
          <label>メールアドレス<input name="email" required type="email" autocomplete="email"></label>
          <label>パスワード<input name="password" required type="password" minlength="8" autocomplete="new-password"></label>
          <label>パスワード確認<input name="passwordConfirm" required type="password" minlength="8" autocomplete="new-password"></label>
          <button class="button primary full" type="submit">登録してマイページに入る</button>
        </form>
      </section>
    </main>`,
    sessionOrg
  );
}

async function loginPage(req, message = "") {
  const sessionOrg = await getSessionOrg(req);
  return page(
    "ログイン",
    `<main class="shell narrow">
      <section>
        <h1>団体ログイン</h1>
        <p>登録済みの団体メールまたは学生メールとパスワードでログインします。</p>
        ${message ? `<p class="notice">${escapeHtml(message)}</p>` : ""}
        <form class="panel form single" method="post" action="/auth/login">
          <label>メールアドレス<input name="email" required type="email" autocomplete="email"></label>
          <label>パスワード<input name="password" required type="password" autocomplete="current-password"></label>
          <button class="button primary full" type="submit">ログインする</button>
        </form>
      </section>
    </main>`,
    sessionOrg
  );
}

async function adminLoginPage(req, message = "") {
  const sessionOrg = await getSessionOrg(req);
  return page(
    "管理ログイン",
    `<main class="shell narrow">
      <section>
        <h1>管理ログイン</h1>
        <p>学友会管理者だけが予約一覧、メールログ、SwitchBot設定を確認できます。</p>
        ${message ? `<p class="notice">${escapeHtml(message)}</p>` : ""}
        <form class="panel form single" method="post" action="/admin/login">
          <label>管理トークン<input name="token" required type="password" autocomplete="current-password"></label>
          <button class="button primary full" type="submit">管理画面に入る</button>
        </form>
      </section>
    </main>`,
    sessionOrg
  );
}

async function reservePage(req, { message = "", input = {} } = {}) {
  const sessionOrg = await getSessionOrg(req);
  if (!sessionOrg) return null;
  const db = await getDb();
  const activeRooms = orderedRooms(db, { activeOnly: true });
  const availableRooms = activeRooms.filter((room) => canOrganizationReserveRoom(sessionOrg.organization, room));
  const preservedRoomIds = new Set(selectedRoomIds(input));
  const roomChecks = activeRooms
    .map((room) => {
      const permitted = canOrganizationReserveRoom(sessionOrg.organization, room);
      return `<label class="facility-option${permitted ? "" : " restricted"}">
      <input type="checkbox" name="roomIds" value="${room.id}" ${permitted && preservedRoomIds.has(room.id) ? "checked" : ""} ${permitted ? "" : "disabled"}>
      <span class="facility-option-mark" aria-hidden="true">${permitted ? "✓" : "!"}</span>
      <span class="facility-option-copy"><strong>${escapeHtml(room.name)}</strong><small>${permitted ? "予約時間中のみ利用できます" : "委員会のみ利用できます"}</small></span>
    </label>`;
    })
    .join("");
  const representativeName = input.representativeName ?? sessionOrg.organization.representativeName;
  const startsAt = input.startsAt ?? "";
  const endsAt = input.endsAt ?? "";
  const purpose = input.purpose ?? "";
  return page(
    "予約申請",
    `<main class="shell reservation-page">
      <header class="reservation-hero-v2">
        <div>
          <span class="eyebrow">FACILITY RESERVATION</span>
          <h1>施設予約申請</h1>
          <p>上から順番に入力すると、スマートフォンでも迷わず申請できます。</p>
        </div>
        <ol class="reservation-progress" aria-label="申請の入力手順">
          <li><span>1</span>施設</li><li><span>2</span>日時</li><li><span>3</span>用途</li>
        </ol>
      </header>
      ${message ? `<div class="reservation-error" role="alert"><strong>申請できませんでした</strong><p>${escapeHtml(message)}</p></div>` : ""}
      <div class="reservation-layout-v2">
        <form class="reservation-form-v2" method="post" action="/api/reservations">
          <section class="reservation-card applicant-card" aria-labelledby="applicant-heading">
            <div class="reservation-card-head">
              <span class="reservation-card-icon" aria-hidden="true">団</span>
              <div><h2 id="applicant-heading">申請団体</h2><p>ログイン中の団体情報を使用します。</p></div>
            </div>
            <div class="applicant-summary">
              <div><span>団体名</span><strong>${escapeHtml(sessionOrg.organization.name)}</strong></div>
              <label><span>代表者名</span><input name="representativeName" required maxlength="80" value="${escapeHtml(representativeName)}" autocomplete="name"></label>
            </div>
          </section>

          <section class="reservation-card reservation-step-card room-step" role="group" aria-labelledby="room-step-heading">
            <div class="step-heading"><span class="step-number">1</span><span><h2 id="room-step-heading">利用する施設</h2><small>複数選択できます</small></span></div>
            ${roomChecks
              ? `<div class="facility-option-grid">${roomChecks}</div><p class="selection-status" aria-live="polite"><strong data-selected-room-count>0施設</strong>を選択中</p>`
              : `<p class="reservation-empty" role="status">現在表示できる施設がありません。学友会本部へお問い合わせください。</p>`}
          </section>

          <section class="reservation-card reservation-step-card date-step" role="group" aria-labelledby="date-step-heading">
            <div class="step-heading"><span class="step-number">2</span><span><h2 id="date-step-heading">利用日時</h2><small>開始と終了を確認してください</small></span></div>
            <div class="reservation-date-grid">
              <label><span>開始日時（日本時間）</span><small>施設を使い始める日時</small><input name="startsAt" type="datetime-local" required value="${escapeHtml(startsAt)}"></label>
              <span class="date-arrow" aria-hidden="true">→</span>
              <label><span>終了日時（日本時間）</span><small>施設を使い終わる日時</small><input name="endsAt" type="datetime-local" required value="${escapeHtml(endsAt)}"></label>
            </div>
            <p class="date-help">一時暗証番号は、設定された安全バッファを含む時間だけ有効です。</p>
          </section>

          <section class="reservation-card reservation-step-card purpose-step" aria-labelledby="purpose-heading">
            <div class="step-heading"><span class="step-number">3</span><span><h2 id="purpose-heading">利用用途</h2><small>管理者が確認しやすいよう具体的に入力してください</small></span></div>
            <label class="purpose-field"><span class="visually-hidden">利用用途</span><textarea name="purpose" rows="4" maxlength="500" placeholder="例：定例会議、資料作成、新入生向け説明会">${escapeHtml(purpose)}</textarea><small>500文字以内・未入力でも申請できます</small></label>
          </section>

          <section class="reservation-mobile-guide" aria-labelledby="mobile-guide-heading">
            <h2 id="mobile-guide-heading">申請前の確認</h2>
            <ul><li>申請後は学友会の承認を待ちます。</li><li>暗証番号は承認後、マイページに表示されます。</li><li>Discordには暗証番号を掲載しません。</li></ul>
          </section>

          <div class="reservation-submit-bar">
            <p><strong>入力内容を確認してください</strong><span>送信後はマイページで状態を確認できます。</span></p>
            <button class="button primary submit-button" type="submit" ${availableRooms.length ? "" : "disabled"}>この内容で申請する</button>
          </div>
        </form>

        <aside class="reservation-guide-v2" aria-labelledby="reservation-guide-heading">
          <section class="reservation-guide-card">
            <span class="eyebrow">BEFORE YOU BOOK</span>
            <h2 id="reservation-guide-heading">申請前の確認</h2>
            <ol class="guide-steps">
              <li><span>1</span><div><strong>申請を送信</strong><p>利用施設・日時・用途を入力します。</p></div></li>
              <li><span>2</span><div><strong>学友会が確認</strong><p>申請内容を管理者が確認します。</p></div></li>
              <li><span>3</span><div><strong>マイページで確認</strong><p>承認後に一時暗証番号を確認できます。</p></div></li>
            </ol>
          </section>
          <section class="reservation-guide-card security-card">
            <h2>暗証番号について</h2>
            <p>暗証番号はDiscordへ掲載されません。団体の関係者以外には共有しないでください。</p>
            <a class="text-link" href="/mypage">マイページを確認する</a>
          </section>
        </aside>
      </div>
    </main>`,
    sessionOrg
  );
}

async function myPage(req) {
  const sessionOrg = await getSessionOrg(req);
  if (!sessionOrg) return null;
  const db = await getDb();
  const organizationReservations = db.reservations
    .filter((reservation) => reservation.organizationId === sessionOrg.organization.id);
  const cancelledReservations = organizationReservations
    .filter((reservation) => reservation.status === "cancelled")
    .sort((a, b) => new Date(b.cancelledAt || b.updatedAt || b.createdAt).getTime()
      - new Date(a.cancelledAt || a.updatedAt || a.createdAt).getTime());
  const cancellationUpdates = cancelledReservations.length
    ? `<section class="cancellation-updates" aria-labelledby="cancellation-updates-heading">
        <div class="cancellation-updates-head">
          <div>
            <span class="eyebrow">RESERVATION UPDATE</span>
            <h2 id="cancellation-updates-heading">予約のお知らせ</h2>
          </div>
          <span class="chip cancelled">${cancelledReservations.length}件</span>
        </div>
        <div class="cancellation-update-list">
          ${cancelledReservations.slice(0, 3).map((reservation) => `<article class="cancellation-update">
            <div>
              <span class="chip cancelled">キャンセル済み</span>
              <h3>予約がキャンセルされました</h3>
              <p>${escapeHtml(roomNames(db, reservation))} / ${escapeHtml(formatDateTime(reservation.startsAt))} - ${escapeHtml(formatDateTime(reservation.endsAt))}</p>
              ${reservation.cancelComment ? `<p class="cancellation-reason"><strong>理由:</strong> ${escapeHtml(reservation.cancelComment)}</p>` : ""}
            </div>
            <a class="button small" href="/r/${reservation.publicToken}">詳細を確認</a>
          </article>`).join("")}
        </div>
        ${cancelledReservations.length > 3 ? `<p class="muted cancellation-more">ほか${cancelledReservations.length - 3}件は下の予約一覧で確認できます。</p>` : ""}
      </section>`
    : "";
  const reservations = organizationReservations
    .map((reservation) => {
      const view = publicReservation(reservation);
      const codes = view.passcodes
        .filter((passcode) => passcode.code)
        .map((passcode) => {
          const room = db.rooms.find((item) => item.id === passcode.roomId);
          return `<span class="code-pill">${escapeHtml(room?.name || passcode.roomId)}: ${escapeHtml(passcode.code)}</span>`;
        })
        .join("");
      return `<tr>
        <td data-label="状態"><span class="chip ${reservation.status}">${statusLabel(reservation.status)}</span></td>
        <td data-label="施設">${escapeHtml(roomNames(db, reservation))}</td>
        <td data-label="日時">${escapeHtml(formatDateTime(reservation.startsAt))}<small>${escapeHtml(formatDateTime(reservation.endsAt))}</small></td>
        <td data-label="暗証番号">${codes || "<span class='muted'>承認後に表示</span>"}</td>
        <td data-label="操作"><a class="button small" href="/r/${reservation.publicToken}">確認</a></td>
      </tr>`;
    })
    .join("");
  return page(
    "マイページ",
    `<main class="shell">
      <section class="section-head">
        <div>
          <h1>${escapeHtml(sessionOrg.organization.name)}のマイページ</h1>
          <p>予約状況、承認結果、一時暗証番号を確認できます。</p>
        </div>
        <a class="button primary" href="/reserve">新規予約</a>
      </section>
      ${cancellationUpdates}
      ${renderTimeline(db, { currentOrganizationId: sessionOrg.organization.id })}
      <section class="panel table-panel table-scroll">
        <table class="mobile-card-table">
          <thead><tr><th>状態</th><th>施設</th><th>日時</th><th>暗証番号</th><th>操作</th></tr></thead>
          <tbody>${reservations || `<tr><td colspan="5" class="empty">まだ予約はありません。</td></tr>`}</tbody>
        </table>
      </section>
    </main>`,
    sessionOrg
  );
}

async function adminPage(req) {
  const db = await getDb();
  const requestUrl = new URL(req.url, config.baseUrl);
  const roomStatus = requestUrl.searchParams.get("roomStatus");
  const roomMessage = {
    created: { className: "success", text: "施設を追加しました。予約申請画面へ自動的に反映されます。" },
    updated: { className: "success", text: "施設名・deviceId・有効状態を保存しました。" },
    moved: { className: "success", text: "施設の表示順を入れ替えました。" },
    archived: { className: "success", text: "施設を削除済みに移動しました。過去の予約履歴は残ります。" },
    restored: { className: "success", text: "施設を復元しました。必要に応じて有効へ切り替えてください。" },
    "missing-name": { className: "danger", text: "施設名を入力してください。" },
    duplicate: { className: "danger", text: "同じ名前の施設がすでに登録されています。" },
    "device-required": { className: "danger", text: "有効にする場合はKeypad deviceIdを入力してください。" },
    "future-reservations": { className: "danger", text: "今後の有効な予約があるため削除できません。先に予約をキャンセルしてください。" },
    invalid: { className: "danger", text: "施設名またはdeviceIdが長すぎます。" }
  }[roomStatus] || null;
  const organizationStatus = requestUrl.searchParams.get("organizationStatus");
  const organizationMessage = {
    reset: { className: "success", text: "団体アカウントを年度リセットしました。予約・暗証番号・監査履歴は保持しています。" },
    "reset-date": { className: "danger", text: "年度リセットは日本時間の3月31日だけ実行できます。" },
    "reset-confirmation": { className: "danger", text: "確認欄へ「年度リセット」と入力してください。" },
    "reset-empty": { className: "danger", text: "リセット対象の団体がありません。" },
    "access-updated": { className: "success", text: "団体区分を更新しました。委員会だけがコピー室を申請できます。" },
    "access-invalid": { className: "danger", text: "団体区分が不正です。一般団体または委員会を選んでください。" },
    "access-not-found": { className: "danger", text: "対象の団体が見つかりません。" }
  }[organizationStatus] || null;
  const selectedDate = parseDateInput(requestUrl.searchParams.get("date"));
  const currentRooms = orderedRooms(db);
  const archivedRooms = orderedRooms(db, { includeArchived: true }).filter((room) => room.archivedAt);
  const roomRows = currentRooms
    .map((room, index) => `<tr>
      <td data-label="施設名"><input form="rooms-form" name="name:${escapeHtml(room.id)}" maxlength="60" required value="${escapeHtml(room.name)}" aria-label="${escapeHtml(room.name)}の施設名"></td>
      <td data-label="ID"><code>${escapeHtml(room.id)}</code></td>
      <td data-label="Keypad deviceId"><input form="rooms-form" name="deviceId:${escapeHtml(room.id)}" value="${escapeHtml(room.deviceId)}"></td>
      <td data-label="状態"><label class="inline-check"><input form="rooms-form" type="checkbox" name="active:${escapeHtml(room.id)}" ${room.active ? "checked" : ""}> 有効</label></td>
      <td data-label="並び替え・削除" class="room-row-actions">
        <form method="post" action="/admin/rooms/${room.id}/move">
          <button class="button small icon-only" name="direction" value="up" type="submit" ${index === 0 ? "disabled" : ""} aria-label="${escapeHtml(room.name)}を上へ移動">↑</button>
          <button class="button small icon-only" name="direction" value="down" type="submit" ${index === currentRooms.length - 1 ? "disabled" : ""} aria-label="${escapeHtml(room.name)}を下へ移動">↓</button>
        </form>
        <form method="post" action="/admin/rooms/${room.id}/archive">
          <label class="inline-check"><input type="checkbox" name="confirm" value="yes" required> 確認</label>
          <button class="button small danger" type="submit">削除</button>
        </form>
      </td>
    </tr>`)
    .join("");
  const archivedRoomRows = archivedRooms
    .map((room) => `<tr>
      <td data-label="施設">${escapeHtml(room.name)}</td>
      <td data-label="ID"><code>${escapeHtml(room.id)}</code></td>
      <td data-label="削除日時">${escapeHtml(formatDateTime(room.archivedAt))}</td>
      <td data-label="操作"><form method="post" action="/admin/rooms/${room.id}/restore"><button class="button small" type="submit">復元</button></form></td>
    </tr>`)
    .join("");
  const organizationRows = db.organizations
    .map((organization) => {
      const reservationCount = db.reservations.filter((reservation) => reservation.organizationId === organization.id).length;
      return `<tr>
        <td data-label="団体">${escapeHtml(organization.name)}<small>${escapeHtml(organization.representativeName || "")}</small></td>
        <td data-label="メール">${escapeHtml(organization.email)}</td>
        <td data-label="団体区分">
          <form class="organization-role-form" method="post" action="/admin/organizations/${organization.id}/access-role">
            <select name="facilityAccessRole" aria-label="${escapeHtml(organization.name)}の団体区分">
              <option value="general" ${facilityAccessRole(organization) === "general" ? "selected" : ""}>一般団体</option>
              <option value="committee" ${facilityAccessRole(organization) === "committee" ? "selected" : ""}>委員会</option>
            </select>
            <button class="button small" type="submit">保存</button>
          </form>
          <small class="organization-role-note">${facilityAccessRole(organization) === "committee" ? "コピー室を申請できます" : "コピー室は申請できません"}</small>
        </td>
        <td data-label="予約数">${reservationCount}</td>
        <td data-label="登録日">${escapeHtml(formatDateTime(organization.createdAt || new Date()))}</td>
        <td data-label="操作">
          <form class="inline-form" method="post" action="/admin/organizations/${organization.id}/delete">
            <label class="inline-check"><input type="checkbox" name="confirm" value="yes" required> 確認</label>
            <button class="button small danger" type="submit">削除</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");
  const reservationRow = (reservation) => `<tr>
        <td data-label="申請ID"><a class="text-link" href="/admin/reservations/${reservation.id}">${escapeHtml(reservationIdLabel(reservation.id))}</a></td>
        <td data-label="団体">${escapeHtml(reservation.organizationName)}<small>${escapeHtml(reservation.representativeName)}</small></td>
        <td data-label="施設">${escapeHtml(roomNames(db, reservation))}</td>
        <td data-label="利用日時">${escapeHtml(formatDateTime(reservation.startsAt))}<small>${escapeHtml(formatDateTime(reservation.endsAt))}</small></td>
        <td data-label="申請日時">${escapeHtml(formatShortDateTime(reservation.createdAt))}</td>
        <td data-label="状態"><span class="chip ${reservation.status}">${statusLabel(reservation.status)}</span></td>
      </tr>`;

  const pendingReservations = db.reservations
    .filter((reservation) => ["pending", "issuing_failed"].includes(reservation.status))
    .map(reservationRow)
    .join("");
  const reservations = db.reservations
    .map((reservation) => `<tr>
        <td data-label="申請ID"><a class="text-link" href="/admin/reservations/${reservation.id}">${escapeHtml(reservationIdLabel(reservation.id))}</a></td>
        <td data-label="状態"><span class="chip ${reservation.status}">${statusLabel(reservation.status)}</span></td>
        <td data-label="場所">${escapeHtml(roomNames(db, reservation))}</td>
        <td data-label="団体">${escapeHtml(reservation.organizationName)}<small>${escapeHtml(reservation.representativeName)}</small></td>
        <td data-label="日時">${escapeHtml(formatDateTime(reservation.startsAt))}<small>${escapeHtml(formatDateTime(reservation.endsAt))}</small></td>
        <td data-label="用途">${escapeHtml(truncate(reservation.purpose || "未記入", 36))}</td>
        <td data-label="操作" class="table-actions">
          <a class="button small" href="/r/${reservation.publicToken}">確認</a>
          <a class="button small primary" href="/admin/reservations/${reservation.id}">管理</a>
        </td>
      </tr>`)
    .join("");

  const lockEventRows = renderLockEventRows(db);
  const passcodeLogRows = renderPasscodeLogRows(db);
  const logs = db.auditLogs
    .slice(0, 10)
    .map((log) => `<li><strong>${escapeHtml(log.action)}</strong><span>${escapeHtml(formatDateTime(log.createdAt))}</span></li>`)
    .join("");
  const notificationCount = db.reservations.filter((reservation) => reservation.status === "pending").length;
  const approvedCount = db.reservations.filter((reservation) => reservation.status === "approved").length;
  const activeRoomCount = orderedRooms(db, { activeOnly: true }).length;

  return adminLayout(
    "管理画面",
    `<main class="admin-main">
      <section class="admin-page-head">
        <div><span class="eyebrow">ADMIN CONSOLE</span><h1>管理ダッシュボード</h1></div>
        <p>予約申請・施設・解錠状況をまとめて確認できます。</p>
      </section>
      ${config.switchbotMock ? `<p class="notice warning">SwitchBotはMockモードです。この状態で承認しても実機アプリにはパスコードが登録されません。.envのSWITCHBOT_MOCK=falseを確認してサーバーを再起動してください。</p>` : ""}
      <section class="admin-stats">
        <article><span>承認待ち</span><strong>${notificationCount}</strong></article>
        <article><span>承認済み</span><strong>${approvedCount}</strong></article>
        <article><span>登録団体</span><strong>${db.organizations.length}</strong></article>
        <article><span>有効施設</span><strong>${activeRoomCount}</strong></article>
      </section>
      <section class="admin-primary">
        <section class="admin-card" id="pending">
          <div class="card-head">
            <div><h2>承認待ち申請</h2><p>確認と対応が必要な申請</p></div>
            <a class="text-link" href="#reservations">すべて表示</a>
          </div>
          <div class="table-scroll">
            <table class="compact-table mobile-card-table">
              <thead><tr><th>申請ID</th><th>団体名</th><th>施設</th><th>利用日時</th><th>申請日時</th><th>ステータス</th></tr></thead>
              <tbody>${pendingReservations || `<tr><td colspan="6" class="empty">承認待ちの予約はありません。</td></tr>`}</tbody>
            </table>
          </div>
        </section>
        ${renderAdminDayTimeline(db, selectedDate)}
      </section>
      <section class="admin-tools-head">
        <div><h2>管理ツール</h2><p>必要な項目だけ開いて確認・編集できます。</p></div>
      </section>
      <section class="admin-tools">
        <details class="admin-card admin-tool" id="requests" ${organizationMessage ? "open" : ""}>
          <summary class="tool-summary"><span><strong>団体一覧</strong><small>${db.organizations.length}団体のアカウント管理</small></span><span class="summary-action">開く</span></summary>
          <div class="tool-content">
            ${organizationMessage ? `<p class="room-form-message ${organizationMessage.className}" role="status">${organizationMessage.text}</p>` : ""}
            <div class="tool-actions"><a class="text-link" href="/register">団体登録</a></div>
            <div class="table-scroll">
              <table class="compact-table mobile-card-table">
                <thead><tr><th>団体</th><th>メール</th><th>団体区分</th><th>予約数</th><th>登録日</th><th>操作</th></tr></thead>
                <tbody>${organizationRows || `<tr><td colspan="6" class="empty">登録団体はまだありません。</td></tr>`}</tbody>
              </table>
            </div>
            <section class="annual-reset-section">
              <div><h3>年度末の団体一斉リセット</h3><p>日本時間の3月31日に、団体アカウントとログイン情報を削除して翌年度の再登録を可能にします。予約・暗証番号・監査履歴は削除しません。</p></div>
              <form method="post" action="/admin/organizations/annual-reset">
                <label>確認入力<input name="confirmation" required autocomplete="off" placeholder="年度リセット" ${isAnnualOrganizationResetDate() ? "" : "disabled"}></label>
                <button class="button danger" type="submit" ${isAnnualOrganizationResetDate() ? "" : "disabled"}>全団体をリセット</button>
              </form>
              <p class="annual-reset-note">実行可能日: 毎年3月31日（日本時間）${isAnnualOrganizationResetDate() ? "・本日実行できます" : "・現在は実行できません"}</p>
            </section>
          </div>
        </details>
        <details class="admin-card admin-tool" id="reservations">
          <summary class="tool-summary"><span><strong>予約一覧</strong><small>${db.reservations.length}件の用途・状態・詳細操作</small></span><span class="summary-action">開く</span></summary>
          <div class="tool-content">
            <div class="table-scroll">
              <table class="compact-table mobile-card-table">
                <thead><tr><th>申請ID</th><th>状態</th><th>場所</th><th>団体</th><th>日時</th><th>用途</th><th>操作</th></tr></thead>
                <tbody>${reservations || `<tr><td colspan="7" class="empty">まだ予約はありません。</td></tr>`}</tbody>
              </table>
            </div>
          </div>
        </details>
        <details class="admin-card admin-tool" id="usage">
          <summary class="tool-summary"><span><strong>施錠・解錠履歴</strong><small>物理Lockイベントと暗証番号操作</small></span><span class="summary-action">開く</span></summary>
          <div class="tool-content">
            <div class="tool-actions"><a class="text-link" href="/mailbox">メールログを開く</a></div>
            <section class="history-section">
              <div class="history-head"><h3>実際の施錠・解錠</h3><p>SwitchBot Lockから受信した最新25件</p></div>
              <div class="table-scroll">
                <table class="compact-table mobile-card-table">
                  <thead><tr><th>日時</th><th>施設</th><th>状態</th><th>予約団体</th><th>電池</th></tr></thead>
                  <tbody>${lockEventRows || `<tr><td colspan="5" class="empty">施錠・解錠イベントはまだありません。</td></tr>`}</tbody>
                </table>
              </div>
            </section>
            <section class="history-section">
              <div class="history-head"><h3>暗証番号・API処理</h3><p>暗証番号そのものは表示しません</p></div>
              <div class="table-scroll">
                <table class="compact-table mobile-card-table">
                  <thead><tr><th>日時</th><th>団体名</th><th>施設</th><th>操作</th><th>結果</th><th>備考</th></tr></thead>
                  <tbody>${passcodeLogRows || `<tr><td colspan="6" class="empty">暗証番号の操作履歴はまだありません。</td></tr>`}</tbody>
                </table>
              </div>
            </section>
          </div>
        </details>
        <details class="admin-card admin-tool" id="rooms" ${roomMessage ? "open" : ""}>
          <summary class="tool-summary"><span><strong>施設設定</strong><small>Keypad deviceIdと施設の有効状態</small></span><span class="summary-action">開く</span></summary>
          <div class="tool-content">
            ${roomMessage ? `<p class="room-form-message ${roomMessage.className}" role="status">${roomMessage.text}</p>` : ""}
            <section class="room-create-section" aria-labelledby="room-create-title">
              <div><h3 id="room-create-title">申請施設を追加</h3><p>追加した施設は、有効化すると予約申請・空き状況・SwitchBotパネルへ自動反映されます。</p></div>
              <form class="room-create-form" method="post" action="/admin/rooms/create">
                <label>施設名<input name="name" maxlength="60" required placeholder="例：多目的室"></label>
                <label>Keypad deviceId<input name="deviceId" maxlength="128" placeholder="SwitchBotのdeviceId"></label>
                <label class="inline-check room-active-check"><input type="checkbox" name="active" value="yes"> 追加後すぐ申請可能にする</label>
                <button class="button primary" type="submit">施設を追加</button>
              </form>
              <p class="room-create-help">Keypadが未準備の場合は有効化せず追加し、deviceId設定後に下の一覧から有効へ切り替えてください。</p>
            </section>
            <form id="rooms-form" method="post" action="/admin/rooms"></form>
            <div class="table-scroll">
            <table class="compact-table mobile-card-table">
              <thead><tr><th>施設名</th><th>ID</th><th>Keypad deviceId</th><th>状態</th><th>並び替え・削除</th></tr></thead>
              <tbody>${roomRows}</tbody>
            </table>
          </div>
            <div class="panel-footer"><button class="button primary" form="rooms-form" type="submit">部屋設定を保存</button></div>
            ${archivedRoomRows ? `<details class="archived-rooms"><summary>削除済み施設（${archivedRooms.length}件）</summary><div class="table-scroll"><table class="compact-table mobile-card-table"><thead><tr><th>施設</th><th>ID</th><th>削除日時</th><th>操作</th></tr></thead><tbody>${archivedRoomRows}</tbody></table></div></details>` : ""}
          </div>
        </details>
        <details class="admin-card admin-tool" id="codes">
          <summary class="tool-summary"><span><strong>システムログ</strong><small>最新10件の処理履歴</small></span><span class="summary-action">開く</span></summary>
          <div class="tool-content"><ul class="log-list">${logs || "<li>ログはまだありません。</li>"}</ul></div>
        </details>
      </section>
    </main>`,
    { notificationCount }
  );
}

async function reservationPage(req, token) {
  const db = await getDb();
  const sessionOrg = await getSessionOrg(req);
  const reservation = db.reservations.find((item) => item.publicToken === token);
  if (!reservation) return null;
  const isOwner = sessionOrg?.organization.id === reservation.organizationId;
  if (!isOwner && !isAdminRequest(req)) return null;
  const view = publicReservation(reservation);
  const storedPasscodes = db.passcodes.filter((passcode) => passcode.reservationId === reservation.id);
  const hasMockPasscode = storedPasscodes.some(isMockPasscode);
  const codeBlock = view.passcodes.some((passcode) => passcode.code)
    ? `<div class="passcode-list">${view.passcodes
        .filter((passcode) => passcode.code)
        .map((passcode) => {
          const room = db.rooms.find((item) => item.id === passcode.roomId);
          return `<div><span>${escapeHtml(room?.name || passcode.roomId)}</span><strong>${escapeHtml(passcode.code)}</strong></div>`;
        })
        .join("")}</div><p>有効期間: ${escapeHtml(formatDateTime(view.passcodes[0].startsAt))} から ${escapeHtml(formatDateTime(view.passcodes[0].endsAt))}</p>`
    : `<p class="muted">承認後に一時暗証番号が表示されます。</p>`;

  return page(
    "予約確認",
    `<main class="shell narrow">
      <section class="panel confirmation">
        <span class="chip ${reservation.status}">${statusLabel(reservation.status)}</span>
        <h1>${escapeHtml(roomNames(db, reservation))}の予約</h1>
        <dl>
          <dt>団体</dt><dd>${escapeHtml(reservation.organizationName)}</dd>
          <dt>代表者</dt><dd>${escapeHtml(reservation.representativeName)}</dd>
          <dt>開始</dt><dd>${escapeHtml(formatDateTime(reservation.startsAt))}</dd>
          <dt>終了</dt><dd>${escapeHtml(formatDateTime(reservation.endsAt))}</dd>
          <dt>用途</dt><dd>${escapeHtml(reservation.purpose || "未記入")}</dd>
          ${reservation.rejectionComment ? `<dt>却下コメント</dt><dd>${escapeHtml(reservation.rejectionComment)}</dd>` : ""}
          ${reservation.cancelComment ? `<dt>キャンセル理由</dt><dd>${escapeHtml(reservation.cancelComment)}</dd>` : ""}
        </dl>
        ${hasMockPasscode ? `<p class="notice warning">この暗証番号はMockモードで発行されたため、SwitchBot実機には登録されていません。管理者に再発行を依頼してください。</p>` : ""}
        ${codeBlock}
      </section>
    </main>`,
    sessionOrg
  );
}

async function adminReservationPage(req, id, message = "") {
  const db = await getDb();
  const sessionOrg = await getSessionOrg(req);
  const reservation = db.reservations.find((item) => item.id === id);
  if (!reservation) return null;
  const rooms = roomList(db, reservation);
  const organization = db.organizations.find((item) => item.id === reservation.organizationId);
  const restrictedRooms = restrictedRoomsForOrganization(organization, rooms);
  const approvalAccessBlocked = ["pending", "issuing_failed"].includes(reservation.status) && restrictedRooms.length > 0;
  const passcodes = db.passcodes
    .filter((passcode) => passcode.reservationId === reservation.id)
    .map((passcode) => {
      const room = db.rooms.find((item) => item.id === passcode.roomId);
      const mockLabel = isMockPasscode(passcode) ? " / Mock発行" : "";
      return `<tr>
        <td data-label="施設">${escapeHtml(room?.name || passcode.roomId)}</td>
        <td data-label="暗証番号"><code>${escapeHtml(passcode.code || "")}</code></td>
        <td data-label="状態"><span class="chip ${passcode.status}">${escapeHtml(passcode.status)}${mockLabel}</span></td>
        <td data-label="passcode id">${escapeHtml(passcode.keyId || "未取得")}</td>
        <td data-label="削除状態">${escapeHtml(passcode.deleteStatus || "未削除")}</td>
        <td data-label="警告">${escapeHtml(passcode.warning || "-")}</td>
      </tr>`;
    })
    .join("");
  const hasMockPasscode = db.passcodes
    .filter((passcode) => passcode.reservationId === reservation.id)
    .some(isMockPasscode);
  const canApprove = ["pending", "issuing_failed"].includes(reservation.status) && !approvalAccessBlocked;
  const canReject = ["pending", "issuing_failed"].includes(reservation.status);
  const canCancel = ["approved", "issuing", "cancel_failed"].includes(reservation.status);

  return page(
    "予約管理",
    `<main class="shell">
      <section class="section-head">
        <div>
          <h1>予約詳細</h1>
          <p>${escapeHtml(reservation.organizationName)} / ${escapeHtml(roomNames(db, reservation))}</p>
        </div>
        <a class="button" href="/admin">管理画面に戻る</a>
      </section>
      ${message ? `<p class="notice">${escapeHtml(message)}</p>` : ""}
      ${approvalAccessBlocked ? `<p class="notice warning">この団体は一般団体のため、${escapeHtml(restrictedRooms.map((room) => room.name).join("、"))}を含む予約を承認できません。団体一覧で委員会へ変更するか、申請を却下してください。</p>` : ""}
      ${reservation.cancelWarning ? `<p class="notice warning">${escapeHtml(reservation.cancelWarning)}</p>` : ""}
      ${hasMockPasscode ? `<p class="notice warning">この予約の暗証番号はMockモードで発行されています。画面には表示されますが、SwitchBot実機には登録されていません。SWITCHBOT_MOCK=falseでサーバーを再起動したあと、予約をキャンセルして再申請・再承認してください。</p>` : ""}
      <section class="detail-grid">
        <article class="panel confirmation">
          <span class="chip ${reservation.status}">${statusLabel(reservation.status)}</span>
          <dl>
            <dt>団体</dt><dd>${escapeHtml(reservation.organizationName)}</dd>
            <dt>団体区分</dt><dd>${escapeHtml(organization ? facilityAccessRoleLabel(organization) : "団体アカウント未登録")}</dd>
            <dt>代表者</dt><dd>${escapeHtml(reservation.representativeName)}</dd>
            <dt>連絡先</dt><dd>${escapeHtml(reservation.contact)}</dd>
            <dt>施設</dt><dd>${escapeHtml(rooms.map((room) => room.name).join("、"))}</dd>
            <dt>開始</dt><dd>${escapeHtml(formatDateTime(reservation.startsAt))}</dd>
            <dt>終了</dt><dd>${escapeHtml(formatDateTime(reservation.endsAt))}</dd>
            <dt>申請日</dt><dd>${escapeHtml(formatDateTime(reservation.createdAt))}</dd>
            ${reservation.approvedAt ? `<dt>承認日</dt><dd>${escapeHtml(formatDateTime(reservation.approvedAt))}</dd>` : ""}
            ${reservation.rejectedAt ? `<dt>却下日</dt><dd>${escapeHtml(formatDateTime(reservation.rejectedAt))}</dd>` : ""}
            ${reservation.cancelledAt ? `<dt>キャンセル日</dt><dd>${escapeHtml(formatDateTime(reservation.cancelledAt))}</dd>` : ""}
          </dl>
          <div>
            <h2>使用用途</h2>
            <p class="purpose-text">${escapeHtml(reservation.purpose || "未記入")}</p>
          </div>
          ${reservation.rejectionComment ? `<div><h2>却下コメント</h2><p class="purpose-text">${escapeHtml(reservation.rejectionComment)}</p></div>` : ""}
          ${reservation.cancelComment ? `<div><h2>キャンセル理由</h2><p class="purpose-text">${escapeHtml(reservation.cancelComment)}</p></div>` : ""}
        </article>
        <aside class="panel admin-actions">
          <h2>操作</h2>
          ${canApprove ? `<form method="post" action="/admin/reservations/${reservation.id}/approve">
            <button class="button primary full" type="submit">承認して暗証番号を発行</button>
          </form>` : ""}
          ${canReject ? `<form class="form single" method="post" action="/admin/reservations/${reservation.id}/reject">
            <label>却下コメント<textarea name="comment" rows="4" required placeholder="却下理由を入力"></textarea></label>
            <button class="button danger full" type="submit">却下して通知</button>
          </form>` : ""}
          ${canCancel ? `<form class="form single" method="post" action="/admin/reservations/${reservation.id}/cancel">
            <label>キャンセル理由（任意）<textarea name="comment" rows="4" placeholder="誤承認など、必要なら入力"></textarea></label>
            <button class="button danger full" type="submit">予約をキャンセル</button>
          </form>` : ""}
          ${!canApprove && !canReject && !canCancel ? `<p class="muted">現在の状態では操作できません。</p>` : ""}
        </aside>
      </section>
      <section class="panel table-panel table-scroll">
        <table class="mobile-card-table">
          <thead><tr><th>施設</th><th>暗証番号</th><th>状態</th><th>passcode id</th><th>削除状態</th><th>警告</th></tr></thead>
          <tbody>${passcodes || `<tr><td colspan="6" class="empty">まだ暗証番号はありません。</td></tr>`}</tbody>
        </table>
      </section>
    </main>`,
    sessionOrg,
    true
  );
}

async function mailboxPage(req) {
  const db = await getDb();
  const sessionOrg = await getSessionOrg(req);
  const messages = db.emailMessages
    .slice(0, 30)
    .map((message) => `<article class="mail-item">
      <header><strong>${escapeHtml(message.subject)}</strong><span>${escapeHtml(formatDateTime(message.createdAt))}</span></header>
      <p>${escapeHtml(message.to)}</p>
      <pre>${escapeHtml(message.text)}</pre>
    </article>`)
    .join("");
  return page(
    "メールログ",
    `<main class="shell">
      <section class="section-head">
        <div>
          <h1>メールログ</h1>
          <p>開発中は実メール送信の代わりに、ここでログインリンクや通知内容を確認します。</p>
        </div>
      </section>
      <section class="mail-list">${messages || "<p class='muted'>まだメールはありません。</p>"}</section>
    </main>`,
    sessionOrg,
    true
  );
}

async function handleAdminLogin(req, res) {
  const input = await readBody(req);
  if (!isAdminToken(input.token)) {
    return send(res, 403, await adminLoginPage(req, "管理トークンが違います。"));
  }
  redirect(res, "/admin", {
    "Set-Cookie": `admin=${encodeURIComponent(hashToken(config.adminToken))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`
  });
}

async function updateRooms(req, res) {
  if (!isAdminRequest(req)) return send(res, 403, await adminLoginPage(req, "管理ログインが必要です。"));
  const input = await readBody(req);
  const db = await getDb();
  const rooms = orderedRooms(db);
  const updates = rooms.map((room) => ({
    room,
    name: String(input[`name:${room.id}`] || "").trim(),
    deviceId: String(input[`deviceId:${room.id}`] || "").trim(),
    active: Boolean(input[`active:${room.id}`])
  }));
  if (updates.some((update) => !update.name || update.name.length > 60 || update.deviceId.length > 128)) {
    return redirect(res, "/admin?roomStatus=invalid#rooms");
  }
  if (updates.some((update) => update.active && !update.deviceId)) {
    return redirect(res, "/admin?roomStatus=device-required#rooms");
  }
  const names = [
    ...updates.map((update) => update.name.toLocaleLowerCase("ja")),
    ...db.rooms.filter((room) => room.archivedAt).map((room) => room.name.trim().toLocaleLowerCase("ja"))
  ];
  if (new Set(names).size !== names.length) {
    return redirect(res, "/admin?roomStatus=duplicate#rooms");
  }
  for (const update of updates) {
    update.room.name = update.name;
    update.room.deviceId = update.deviceId;
    update.room.active = update.active;
    update.room.updatedAt = new Date().toISOString();
  }
  await saveDb();
  await addAuditLog("rooms.updated", { roomIds: rooms.map((room) => room.id) });
  redirect(res, "/admin?roomStatus=updated#rooms");
}

async function createRoom(req, res) {
  if (!isAdminRequest(req)) return send(res, 403, await adminLoginPage(req, "管理ログインが必要です。"));
  const input = await readBody(req);
  const name = String(input.name || "").trim();
  const deviceId = String(input.deviceId || "").trim();
  const active = input.active === "yes";
  const resultUrl = (status) => `/admin?roomStatus=${status}#rooms`;

  if (!name) return redirect(res, resultUrl("missing-name"));
  if (name.length > 60 || deviceId.length > 128) return redirect(res, resultUrl("invalid"));
  if (active && !deviceId) return redirect(res, resultUrl("device-required"));

  const db = await getDb();
  if (db.rooms.some((room) => room.name.trim().toLocaleLowerCase("ja") === name.toLocaleLowerCase("ja"))) {
    return redirect(res, resultUrl("duplicate"));
  }

  const room = {
    id: makeId("room"),
    name,
    deviceId,
    active,
    sortOrder: db.rooms.reduce((maximum, item) => Math.max(maximum, Number(item.sortOrder || 0)), -1) + 1,
    archivedAt: null,
    createdAt: new Date().toISOString()
  };
  db.rooms.push(room);
  await saveDb();
  await addAuditLog("room.created", { roomId: room.id, active: room.active });
  redirect(res, resultUrl("created"));
}

async function moveRoom(req, res, roomId) {
  if (!isAdminRequest(req)) return send(res, 403, await adminLoginPage(req, "管理ログインが必要です。"));
  const input = await readBody(req);
  const rooms = orderedRooms(await getDb());
  const currentIndex = rooms.findIndex((room) => room.id === roomId);
  const offset = input.direction === "up" ? -1 : input.direction === "down" ? 1 : 0;
  const targetIndex = currentIndex + offset;
  if (currentIndex === -1 || offset === 0 || targetIndex < 0 || targetIndex >= rooms.length) {
    return redirect(res, "/admin#rooms");
  }
  [rooms[currentIndex], rooms[targetIndex]] = [rooms[targetIndex], rooms[currentIndex]];
  rooms.forEach((room, index) => { room.sortOrder = index; });
  await saveDb();
  await addAuditLog("room.moved", { roomId, direction: input.direction });
  redirect(res, "/admin?roomStatus=moved#rooms");
}

async function archiveRoom(req, res, roomId) {
  if (!isAdminRequest(req)) return send(res, 403, await adminLoginPage(req, "管理ログインが必要です。"));
  const input = await readBody(req);
  if (input.confirm !== "yes") return redirect(res, "/admin?roomStatus=invalid#rooms");
  const db = await getDb();
  const room = db.rooms.find((item) => item.id === roomId && !item.archivedAt);
  if (!room) return redirect(res, "/admin#rooms");
  const hasFutureReservation = db.reservations.some((reservation) => {
    const roomIds = Array.isArray(reservation.roomIds) ? reservation.roomIds : [reservation.roomId];
    return roomIds.includes(roomId)
      && !["rejected", "cancelled"].includes(reservation.status)
      && new Date(reservation.endsAt).getTime() > Date.now();
  });
  if (hasFutureReservation) return redirect(res, "/admin?roomStatus=future-reservations#rooms");
  room.active = false;
  room.archivedAt = new Date().toISOString();
  room.updatedAt = room.archivedAt;
  await saveDb();
  await addAuditLog("room.archived", { roomId });
  redirect(res, "/admin?roomStatus=archived#rooms");
}

async function restoreRoom(req, res, roomId) {
  if (!isAdminRequest(req)) return send(res, 403, await adminLoginPage(req, "管理ログインが必要です。"));
  const db = await getDb();
  const room = db.rooms.find((item) => item.id === roomId && item.archivedAt);
  if (!room) return redirect(res, "/admin#rooms");
  room.archivedAt = null;
  room.active = false;
  room.sortOrder = orderedRooms(db).length;
  room.updatedAt = new Date().toISOString();
  await saveDb();
  await addAuditLog("room.restored", { roomId });
  redirect(res, "/admin?roomStatus=restored#rooms");
}

async function annualResetOrganizations(req, res) {
  if (!isAdminRequest(req)) return send(res, 403, await adminLoginPage(req, "管理ログインが必要です。"));
  const input = await readBody(req);
  const resultUrl = (status) => `/admin?organizationStatus=${status}#requests`;
  if (!isAnnualOrganizationResetDate()) return redirect(res, resultUrl("reset-date"));
  if (String(input.confirmation || "").trim() !== "年度リセット") {
    return redirect(res, resultUrl("reset-confirmation"));
  }
  const db = await getDb();
  if (!db.organizations.length) return redirect(res, resultUrl("reset-empty"));
  const result = resetOrganizationsForAcademicYear(db);
  await saveDb();
  await addAuditLog("organizations.annual_reset", {
    organizationCount: result.organizationCount,
    resetAt: result.resetAt,
    reservationsRetained: db.reservations.length
  });
  redirect(res, resultUrl("reset"));
}

async function deleteOrganization(req, res, organizationId) {
  if (!isAdminRequest(req)) return send(res, 403, await adminLoginPage(req, "管理ログインが必要です。"));
  const input = await readBody(req);
  if (input.confirm !== "yes") return send(res, 400, page("400", "<main class='shell'><h1>削除確認が必要です。</h1></main>"));

  const db = await getDb();
  const organization = db.organizations.find((item) => item.id === organizationId);
  if (!organization) return send(res, 404, page("404", "<main class='shell'><h1>団体が見つかりません。</h1></main>"));

  db.organizations = db.organizations.filter((item) => item.id !== organizationId);
  db.sessions = db.sessions.filter((item) => item.organizationId !== organizationId);
  db.loginTokens = db.loginTokens.filter((item) => item.organizationId !== organizationId);
  for (const reservation of db.reservations.filter((item) => item.organizationId === organizationId)) {
    reservation.organizationDeletedAt = new Date().toISOString();
    reservation.updatedAt = new Date().toISOString();
  }
  await saveDb();
  await addAuditLog("organization.deleted", {
    organizationId,
    email: organization.email,
    reservationCount: db.reservations.filter((item) => item.organizationId === organizationId).length
  });
  redirect(res, "/admin");
}

async function updateOrganizationAccessRole(req, res, organizationId) {
  if (!isAdminRequest(req)) return send(res, 403, await adminLoginPage(req, "管理ログインが必要です。"));
  const input = await readBody(req);
  const nextRole = String(input.facilityAccessRole || "");
  const resultUrl = (status) => `/admin?organizationStatus=${status}#requests`;
  if (!FACILITY_ACCESS_ROLES.has(nextRole)) return redirect(res, resultUrl("access-invalid"));

  const db = await getDb();
  const organization = db.organizations.find((item) => item.id === organizationId);
  if (!organization) return redirect(res, resultUrl("access-not-found"));

  const previousRole = facilityAccessRole(organization);
  organization.facilityAccessRole = nextRole;
  organization.updatedAt = new Date().toISOString();
  await saveDb();
  await addAuditLog("organization.access_role_updated", {
    organizationId,
    previousRole,
    nextRole
  });
  redirect(res, resultUrl("access-updated"));
}

async function registerOrganization(req, res) {
  const input = await readBody(req);
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "");
  const passwordConfirm = String(input.passwordConfirm || "");
  if (!input.name || !input.representativeName || !email.includes("@") || password.length < 8) {
    return send(res, 400, await registerPage(req));
  }
  if (password !== passwordConfirm) {
    return send(res, 400, await registerPage(req));
  }

  const db = await getDb();
  let organization = db.organizations.find((item) => item.email === email);
  if (organization) {
    organization.name = String(input.name).trim();
    organization.representativeName = String(input.representativeName).trim();
    organization.passwordHash = hashPassword(password);
    organization.updatedAt = new Date().toISOString();
  } else {
    organization = {
      id: makeId("org"),
      name: String(input.name).trim(),
      representativeName: String(input.representativeName).trim(),
      email,
      passwordHash: hashPassword(password),
      facilityAccessRole: "general",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.organizations.unshift(organization);
  }
  await saveDb();
  await addAuditLog("organization.registered", { organizationId: organization.id, email });
  return createOrgSession(res, organization, "auth.registered_login");
}

async function issueLoginToken(organization) {
  const db = await getDb();
  const token = crypto.randomBytes(24).toString("hex");
  db.loginTokens.unshift({
    id: makeId("login"),
    organizationId: organization.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    usedAt: null,
    createdAt: new Date().toISOString()
  });
  await saveDb();
  await sendEmail(makeLoginEmail({ organization, token }));
}

async function startLogin(req, res) {
  const input = await readBody(req);
  const email = String(input.email || "").trim().toLowerCase();
  const db = await getDb();
  const organization = db.organizations.find((item) => item.email === email);
  if (!organization) return send(res, 404, await loginPage(req, "このメールアドレスはまだ登録されていません。"));
  await issueLoginToken(organization);
  return redirect(res, "/mailbox");
}

async function createOrgSession(res, organization, action = "auth.login") {
  const db = await getDb();
  const session = {
    id: makeId("sid"),
    organizationId: organization.id,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString()
  };
  db.sessions.unshift(session);
  await saveDb();
  await addAuditLog(action, { organizationId: organization.id });
  redirect(res, "/mypage", {
    "Set-Cookie": `sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`
  });
}

async function passwordLogin(req, res) {
  const input = await readBody(req);
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "");
  const db = await getDb();
  const organization = db.organizations.find((item) => item.email === email);
  if (!organization) {
    return send(res, 404, await loginPage(req, "このメールアドレスはまだ登録されていません。"));
  }
  if (!organization.passwordHash) {
    return send(res, 403, await loginPage(req, "この団体はまだパスワード未設定です。団体登録からパスワードを設定してください。"));
  }
  if (!verifyPassword(password, organization.passwordHash)) {
    await addAuditLog("auth.password_failed", { organizationId: organization.id, email });
    return send(res, 403, await loginPage(req, "メールアドレスまたはパスワードが違います。"));
  }
  return createOrgSession(res, organization);
}

async function verifyLogin(req, res, token) {
  const db = await getDb();
  const tokenHash = hashToken(token || "");
  const loginToken = db.loginTokens.find(
    (item) => item.tokenHash === tokenHash && !item.usedAt && new Date(item.expiresAt).getTime() > Date.now()
  );
  if (!loginToken) return send(res, 400, await loginPage(req, "ログインリンクが無効または期限切れです。"));
  loginToken.usedAt = new Date().toISOString();
  await saveDb();
  const organization = db.organizations.find((item) => item.id === loginToken.organizationId);
  if (!organization) return send(res, 400, await loginPage(req, "団体が見つかりません。"));
  return createOrgSession(res, organization, "auth.magic_login");
}

async function createReservation(req, res) {
  const sessionOrg = await getSessionOrg(req);
  if (!sessionOrg) return send(res, 401, { error: "ログインが必要です。" });
  const input = await readBody(req);
  const db = await getDb();
  const roomIds = selectedRoomIds(input);
  const rooms = roomIds.map((id) => db.rooms.find((item) => item.id === id && item.active && !item.archivedAt)).filter(Boolean);
  const startsAtDate = parseJapanDateTimeLocal(input.startsAt);
  const endsAtDate = parseJapanDateTimeLocal(input.endsAt);
  const startsAt = startsAtDate?.toISOString() || null;
  const endsAt = endsAtDate?.toISOString() || null;

  if (rooms.length === 0 || rooms.length !== roomIds.length || !startsAt || !endsAt) {
    return send(res, 400, await reservePage(req, {
      message: "利用施設・開始日時・終了日時を確認してください。",
      input
    }));
  }
  const restrictedRooms = restrictedRoomsForOrganization(sessionOrg.organization, rooms);
  if (restrictedRooms.length) {
    const message = `${restrictedRooms.map((room) => room.name).join("、")}は委員会のみ予約できます。学友会本部に団体区分を確認してください。`;
    if ((req.headers["content-type"] || "").includes("application/json")) {
      return send(res, 403, { error: message });
    }
    return send(res, 403, await reservePage(req, { message, input }));
  }
  if (new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
    return send(res, 400, await reservePage(req, {
      message: "終了日時は開始日時より後にしてください。",
      input
    }));
  }
  if (new Date(startsAt).getTime() < Date.now()) {
    return send(res, 400, await reservePage(req, {
      message: "過去の日時は予約できません。開始日時を現在より後にしてください。",
      input
    }));
  }
  if (hasRoomConflict(db, roomIds, startsAt, endsAt)) {
    return send(res, 409, await reservePage(req, {
      message: "選択した施設には同じ時間帯の予約があります。日時または施設を変更してください。",
      input
    }));
  }

  const reservation = {
    id: makeId("res"),
    publicToken: makeId("view"),
    organizationId: sessionOrg.organization.id,
    roomId: roomIds[0],
    roomIds,
    organizationName: sessionOrg.organization.name,
    representativeName: String(input.representativeName || sessionOrg.organization.representativeName).trim(),
    contact: sessionOrg.organization.email,
    purpose: String(input.purpose || "").trim(),
    startsAt,
    endsAt,
    status: "pending",
    rejectionComment: "",
    cancelComment: "",
    cancelWarning: "",
    approvedAt: null,
    rejectedAt: null,
    cancelledAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.reservations.unshift(reservation);
  await saveDb();
  await addAuditLog("reservation.created", { reservationId: reservation.id, roomIds });
  try {
    await sendEmail(makeReservationCreatedEmail({ organization: sessionOrg.organization, reservation, rooms }));
  } catch (error) {
    await addAuditLog("reservation.created_email_failed", { reservationId: reservation.id, message: error.message });
  }

  const batteryStatuses = await loadRoomBatteryStatuses(rooms);
  await notifyDiscordWithAudit(reservation.id, [{
    audience: "admin",
    event: "application",
    send: () => notifyDiscordAdminApplication(reservation, rooms, batteryStatuses)
  }]);

  if ((req.headers["content-type"] || "").includes("application/json")) {
    return send(res, 201, { reservation: publicReservation(reservation), url: `/r/${reservation.publicToken}` });
  }
  return redirect(res, "/mypage");
}

async function approveReservation(req, res, id, token) {
  if (!isAdminRequest(req) && !isAdminToken(token)) {
    return send(res, 403, page("403", "<main class='shell'><h1>権限がありません。</h1></main>"));
  }
  const db = await getDb();
  const reservation = db.reservations.find((item) => item.id === id);
  if (!reservation) return send(res, 404, page("404", "<main class='shell'><h1>予約が見つかりません。</h1></main>"));
  if (reservation.status === "approved") return redirect(res, `/admin/reservations/${reservation.id}`);
  if (!["pending", "issuing_failed"].includes(reservation.status)) {
    return send(res, 400, await adminReservationPage(req, id, "この状態の予約は承認できません。"));
  }

  const rooms = reservation.roomIds.map((roomId) => db.rooms.find((item) => item.id === roomId)).filter(Boolean);
  const organization = db.organizations.find((item) => item.id === reservation.organizationId);
  const restrictedRooms = restrictedRoomsForOrganization(organization, rooms);
  if (restrictedRooms.length) {
    return send(
      res,
      400,
      await adminReservationPage(
        req,
        id,
        `${restrictedRooms.map((room) => room.name).join("、")}は委員会だけ承認できます。先に団体一覧で団体区分を委員会へ変更するか、申請を却下してください。`
      )
    );
  }
  const sharedCode = String(crypto.randomInt(100000, 999999));

  try {
    db.passcodes = db.passcodes.filter((passcode) => passcode.reservationId !== reservation.id);
    for (const room of rooms) {
      const passcode = await createTemporaryPasscode({ room, reservation, code: sharedCode });
      db.passcodes.unshift({
        id: makeId("pass"),
        reservationId: reservation.id,
        roomId: room.id,
        code: passcode.code,
        startsAt: passcode.startsAt,
        endsAt: passcode.endsAt,
        status: passcode.status,
        commandId: passcode.commandId,
        keyId: passcode.keyId,
        warning: passcode.warning || "",
        raw: passcode.raw,
        createdAt: new Date().toISOString()
      });
    }
    reservation.status = db.passcodes
      .filter((passcode) => passcode.reservationId === reservation.id)
      .every((passcode) => passcode.status === "active")
      ? "approved"
      : "issuing";
    reservation.approvedAt = new Date().toISOString();
    reservation.rejectedAt = null;
    reservation.rejectionComment = "";
    reservation.updatedAt = new Date().toISOString();
    await saveDb();
    await addAuditLog("reservation.approved", { reservationId: reservation.id, roomIds: reservation.roomIds });
    if (organization) {
      const passcodes = db.passcodes.filter((passcode) => passcode.reservationId === reservation.id);
      try {
        await sendEmail(makeReservationStatusEmail({ organization, reservation, rooms, passcodes, statusLabel: "承認済み" }));
      } catch (error) {
        await addAuditLog("reservation.approval_email_failed", { reservationId: reservation.id, message: error.message });
      }
    }
    const batteryStatuses = await loadRoomBatteryStatuses(rooms);
    await notifyDiscordWithAudit(reservation.id, [
      {
        audience: "admin",
        event: "approved",
        send: () => notifyDiscordAdminStatus(reservation, rooms, { status: "approved", batteryStatuses })
      },
      {
        audience: "organization",
        event: "approved",
        send: () => notifyDiscordOrganizationApproval(reservation, rooms, batteryStatuses)
      }
    ]);
  } catch (error) {
    reservation.status = "issuing_failed";
    reservation.updatedAt = new Date().toISOString();
    await saveDb();
    await addAuditLog("switchbot.createKey.failed", { reservationId: reservation.id, message: error.message });
    await notifyDiscordWithAudit(reservation.id, [{
      audience: "admin",
      event: "issuing_failed",
      send: () => notifyDiscordAdminStatus(reservation, rooms, {
        status: "issuing_failed",
        warning: "暗証番号を発行できませんでした。管理画面と監査ログを確認してください。"
      })
    }]);
  }

  return redirect(res, `/admin/reservations/${reservation.id}`);
}

async function rejectReservation(req, res, id, token) {
  if (!isAdminRequest(req) && !isAdminToken(token)) {
    return send(res, 403, page("403", "<main class='shell'><h1>権限がありません。</h1></main>"));
  }
  const input = req.method === "POST" ? await readBody(req) : {};
  const comment = String(input.comment || "").trim();
  const db = await getDb();
  const reservation = db.reservations.find((item) => item.id === id);
  if (!reservation) return send(res, 404, page("404", "<main class='shell'><h1>予約が見つかりません。</h1></main>"));
  if (!["pending", "issuing_failed"].includes(reservation.status)) {
    return send(res, 400, await adminReservationPage(req, id, "この状態の予約は却下できません。"));
  }
  if (!comment) {
    return send(res, 400, await adminReservationPage(req, id, "却下コメントを入力してください。"));
  }
  reservation.status = "rejected";
  reservation.rejectionComment = comment;
  reservation.rejectedAt = new Date().toISOString();
  reservation.updatedAt = new Date().toISOString();
  await saveDb();
  const rooms = reservation.roomIds.map((roomId) => db.rooms.find((item) => item.id === roomId)).filter(Boolean);
  const organization = db.organizations.find((item) => item.id === reservation.organizationId);
  await addAuditLog("reservation.rejected", { reservationId: reservation.id, comment });
  if (organization) {
    try {
      await sendEmail(makeReservationStatusEmail({ organization, reservation, rooms, statusLabel: "却下", comment }));
    } catch (error) {
      await addAuditLog("reservation.rejection_email_failed", { reservationId: reservation.id, message: error.message });
    }
  }
  await notifyDiscordWithAudit(reservation.id, [
    {
      audience: "admin",
      event: "rejected",
      send: () => notifyDiscordAdminStatus(reservation, rooms, { status: "rejected", comment })
    },
    {
      audience: "organization",
      event: "rejected",
      send: () => notifyDiscordOrganizationRejection(reservation, rooms)
    }
  ]);
  return redirect(res, `/admin/reservations/${reservation.id}`);
}

async function cancelReservation(req, res, id) {
  if (!isAdminRequest(req)) {
    return send(res, 403, page("403", "<main class='shell'><h1>権限がありません。</h1></main>"));
  }
  const input = await readBody(req);
  const comment = String(input.comment || "").trim();
  const db = await getDb();
  const reservation = db.reservations.find((item) => item.id === id);
  if (!reservation) return send(res, 404, page("404", "<main class='shell'><h1>予約が見つかりません。</h1></main>"));
  if (!["approved", "issuing", "cancel_failed"].includes(reservation.status)) {
    return send(res, 400, await adminReservationPage(req, id, "この状態の予約はキャンセルできません。"));
  }

  const rooms = roomList(db, reservation);
  const passcodes = db.passcodes.filter((passcode) => passcode.reservationId === reservation.id);
  const manualRooms = [];
  const failedDeletes = [];

  for (const passcode of passcodes) {
    const room = db.rooms.find((item) => item.id === passcode.roomId);
    if (!room) continue;
    try {
      const result = await deleteTemporaryPasscode({ room, passcode });
      passcode.deleteStatus = result.status;
      passcode.deleteCommandId = result.commandId || null;
      passcode.deletedAt = result.status === "deleted" ? new Date().toISOString() : passcode.deletedAt || null;
      if (result.status === "manual_required") manualRooms.push(room.name);
      if (["deleted", "manual_required"].includes(result.status)) passcode.status = "cancelled";
    } catch (error) {
      passcode.deleteStatus = "failed";
      passcode.deleteError = error.message;
      failedDeletes.push(`${room.name}: ${error.message}`);
    }
  }

  reservation.cancelComment = comment;
  reservation.cancelWarning = manualRooms.length
    ? `SwitchBot passcode idが未取得のため、${manualRooms.join("、")}はSwitchBotアプリで手動削除してください。`
    : "";
  reservation.cancelledAt = new Date().toISOString();
  reservation.updatedAt = new Date().toISOString();

  if (failedDeletes.length) {
    reservation.status = "cancel_failed";
    await saveDb();
    await addAuditLog("reservation.cancel_failed", { reservationId: reservation.id, failedDeletes });
    await notifyDiscordWithAudit(reservation.id, [{
      audience: "admin",
      event: "cancel_failed",
      send: () => notifyDiscordAdminStatus(reservation, rooms, {
        status: "cancel_failed",
        warning: "一部の暗証番号を削除できませんでした。管理画面と監査ログを確認してください。"
      })
    }]);
    return send(res, 500, await adminReservationPage(req, id, "一部のSwitchBot暗証番号削除に失敗しました。"));
  }

  reservation.status = "cancelled";
  await saveDb();
  const organization = db.organizations.find((item) => item.id === reservation.organizationId);
  await addAuditLog("reservation.cancelled", { reservationId: reservation.id, comment, manualRooms });
  if (organization) {
    const mailComment = [comment, reservation.cancelWarning].filter(Boolean).join("\n");
    try {
      await sendEmail(makeReservationStatusEmail({ organization, reservation, rooms, statusLabel: "キャンセル済み", comment: mailComment }));
    } catch (error) {
      await addAuditLog("reservation.cancellation_email_failed", { reservationId: reservation.id, message: error.message });
    }
  }
  await notifyDiscordWithAudit(reservation.id, [
    {
      audience: "admin",
      event: "cancelled",
      send: () => notifyDiscordAdminStatus(reservation, rooms, {
        status: "cancelled",
        comment,
        warning: reservation.cancelWarning
      })
    },
    {
      audience: "organization",
      event: "cancelled",
      send: () => notifyDiscordOrganizationCancellation(reservation, rooms)
    }
  ]);
  return redirect(res, `/admin/reservations/${reservation.id}`);
}

async function handleSwitchBotWebhook(req, res) {
  const payload = await readJson(req);
  const db = await getDb();
  const commandId = payload?.context?.commandId
    || payload?.context?.command_id
    || payload?.body?.commandId
    || payload?.body?.command_id
    || payload?.commandId
    || payload?.command_id;
  const passcode = db.passcodes.find((item) => item.commandId && item.commandId === commandId);
  let changed = false;
  if (passcode) {
    const result = payload?.context?.result || payload?.body?.result || payload?.result;
    passcode.status = payload?.body?.success === false || result === "failed" ? "failed" : "active";
    passcode.keyId = payload?.body?.id || payload?.body?.keyId || payload?.body?.keyID || payload?.body?.key_id || passcode.keyId;
    passcode.webhookPayload = payload;
    passcode.updatedAt = new Date().toISOString();
    const reservation = db.reservations.find((item) => item.id === passcode.reservationId);
    if (reservation) {
      const allPasscodes = db.passcodes.filter((item) => item.reservationId === reservation.id);
      reservation.status = allPasscodes.every((item) => item.status === "active") ? "approved" : "issuing_failed";
      reservation.updatedAt = new Date().toISOString();
    }
    changed = true;
  }

  let devicesRaw = null;
  let lockEvent = parseSwitchBotLockEvent(payload, { rooms: db.rooms });
  let deviceMappingAvailable = true;
  if (lockEvent) {
    try {
      devicesRaw = await getSwitchBotDevices();
      changed = syncRoomLockDeviceIds(db.rooms, devicesRaw) || changed;
      lockEvent = parseSwitchBotLockEvent(payload, { rooms: db.rooms, devicesRaw });
    } catch {
      deviceMappingAvailable = false;
    }

    const duplicate = db.switchbotEvents.some((event) => event.eventKey === lockEvent.eventKey);
    if (!duplicate) {
      db.switchbotEvents.unshift({ id: makeId("switchbot_event"), ...lockEvent });
      changed = true;
    }

    if (devicesRaw) {
      for (const event of db.switchbotEvents) {
        if (event.roomId) continue;
        const roomId = findRoomIdForLockDevice(db.rooms, event.deviceId, devicesRaw);
        if (roomId) {
          event.roomId = roomId;
          changed = true;
        }
      }
    }
  }

  if (changed) await saveDb();
  await addAuditLog("switchbot.webhook.received", {
    commandId: commandId || null,
    matchedPasscode: Boolean(passcode),
    lockState: lockEvent?.lockState || null,
    roomId: lockEvent?.roomId || null,
    deviceMappingAvailable
  });
  send(res, 200, { ok: true });
}

async function apiState(res) {
  const db = await getDb();
  send(res, 200, {
    rooms: db.rooms,
    organizations: db.organizations,
    reservations: db.reservations.map(publicReservation),
    emailMessages: db.emailMessages,
    switchbotEvents: db.switchbotEvents,
    auditLogs: db.auditLogs
  });
}

async function apiSwitchBotDevices(res) {
  const devices = await getSwitchBotDevices();
  send(res, 200, devices);
}

async function apiSwitchBotStatuses(res, forceRefresh = false) {
  try {
    const db = await getDb();
    const statuses = await getAllDeviceBatteryStatuses(orderedRooms(db), { forceRefresh });
    send(res, 200, statuses);
  } catch (error) {
    console.error("SwitchBot status panel failed:", error.message);
    send(res, 502, { error: "SwitchBot状態を取得できませんでした。時間をおいて再度お試しください。" });
  }
}

const server = http.createServer(async (req, res) => {
  req.res = res;
  try {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;

    if (req.method === "GET" && ["/app.css", "/app.js", "/switchbot-sort.js"].includes(pathname)) {
      if (await serveStatic(res, pathname)) return;
    }

    if (req.method === "GET" && pathname === "/") return send(res, 200, await homePage(req));
    if (req.method === "GET" && pathname === "/register") return send(res, 200, await registerPage(req));
    if (req.method === "GET" && pathname === "/login") return send(res, 200, await loginPage(req));
    if (req.method === "GET" && pathname === "/logout") return redirect(res, "/", { "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    if (req.method === "GET" && pathname === "/admin/login") return send(res, 200, await adminLoginPage(req));
    if (req.method === "POST" && pathname === "/admin/login") return handleAdminLogin(req, res);
    if (req.method === "GET" && pathname === "/admin/logout") return redirect(res, "/", { "Set-Cookie": "admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    if (req.method === "GET" && pathname === "/reserve") {
      const html = await reservePage(req);
      return html ? send(res, 200, html) : redirect(res, "/login");
    }
    if (req.method === "GET" && pathname === "/mypage") {
      const html = await myPage(req);
      return html ? send(res, 200, html) : redirect(res, "/login");
    }
    if (req.method === "GET" && pathname === "/admin") {
      if (isAdminToken(url.searchParams.get("token"))) {
        return redirect(res, "/admin", {
          "Set-Cookie": `admin=${encodeURIComponent(hashToken(config.adminToken))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`
        });
      }
      return isAdminRequest(req) ? send(res, 200, await adminPage(req)) : redirect(res, "/admin/login");
    }
    if (req.method === "GET" && pathname === "/mailbox") {
      return isAdminRequest(req) ? send(res, 200, await mailboxPage(req)) : redirect(res, "/admin/login");
    }
    if (req.method === "GET" && pathname.startsWith("/admin/reservations/")) {
      const id = pathname.split("/").at(-1);
      if (isAdminToken(url.searchParams.get("token"))) {
        return redirect(res, `/admin/reservations/${id}`, {
          "Set-Cookie": `admin=${encodeURIComponent(hashToken(config.adminToken))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`
        });
      }
      if (!isAdminRequest(req)) return redirect(res, "/admin/login");
      const html = await adminReservationPage(req, id);
      return html ? send(res, 200, html) : send(res, 404, page("404", "<main class='shell'><h1>予約が見つかりません。</h1></main>"));
    }
    if (req.method === "POST" && pathname.match(/^\/admin\/reservations\/[^/]+\/approve$/)) {
      return approveReservation(req, res, pathname.split("/").at(-2), url.searchParams.get("token"));
    }
    if (req.method === "POST" && pathname.match(/^\/admin\/reservations\/[^/]+\/reject$/)) {
      return rejectReservation(req, res, pathname.split("/").at(-2), url.searchParams.get("token"));
    }
    if (req.method === "POST" && pathname.match(/^\/admin\/reservations\/[^/]+\/cancel$/)) {
      return cancelReservation(req, res, pathname.split("/").at(-2));
    }
    if (req.method === "POST" && pathname.match(/^\/admin\/organizations\/[^/]+\/delete$/)) {
      return deleteOrganization(req, res, pathname.split("/").at(-2));
    }
    if (req.method === "POST" && pathname.match(/^\/admin\/organizations\/[^/]+\/access-role$/)) {
      return updateOrganizationAccessRole(req, res, pathname.split("/").at(-2));
    }
    if (req.method === "POST" && pathname === "/admin/organizations/annual-reset") {
      return annualResetOrganizations(req, res);
    }
    if (req.method === "GET" && pathname === "/auth/verify") return verifyLogin(req, res, url.searchParams.get("token"));
    if (req.method === "GET" && pathname.startsWith("/r/")) {
      if (!(await getSessionOrg(req)) && !isAdminRequest(req)) {
        return redirect(res, "/login", { "Cache-Control": "no-store" });
      }
      const html = await reservationPage(req, pathname.split("/").at(-1));
      return html
        ? send(res, 200, html, { "Cache-Control": "no-store" })
        : send(res, 404, page("404", "<main class='shell'><h1>予約が見つかりません。</h1></main>"), { "Cache-Control": "no-store" });
    }
    if (req.method === "GET" && pathname.startsWith("/admin/approve/")) {
      const id = pathname.split("/").at(-1);
      if (isAdminToken(url.searchParams.get("token"))) {
        return redirect(res, `/admin/reservations/${id}`, {
          "Set-Cookie": `admin=${encodeURIComponent(hashToken(config.adminToken))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`
        });
      }
      return isAdminRequest(req) ? redirect(res, `/admin/reservations/${id}`) : redirect(res, "/admin/login");
    }
    if (req.method === "GET" && pathname.startsWith("/admin/reject/")) {
      const id = pathname.split("/").at(-1);
      if (isAdminToken(url.searchParams.get("token"))) {
        return redirect(res, `/admin/reservations/${id}`, {
          "Set-Cookie": `admin=${encodeURIComponent(hashToken(config.adminToken))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`
        });
      }
      return isAdminRequest(req) ? redirect(res, `/admin/reservations/${id}`) : redirect(res, "/admin/login");
    }
    if (req.method === "POST" && pathname === "/admin/rooms") return updateRooms(req, res);
    if (req.method === "POST" && pathname === "/admin/rooms/create") return createRoom(req, res);
    if (req.method === "POST" && pathname.match(/^\/admin\/rooms\/[^/]+\/move$/)) {
      return moveRoom(req, res, pathname.split("/").at(-2));
    }
    if (req.method === "POST" && pathname.match(/^\/admin\/rooms\/[^/]+\/archive$/)) {
      return archiveRoom(req, res, pathname.split("/").at(-2));
    }
    if (req.method === "POST" && pathname.match(/^\/admin\/rooms\/[^/]+\/restore$/)) {
      return restoreRoom(req, res, pathname.split("/").at(-2));
    }
    if (req.method === "GET" && pathname === "/admin/switchbot/statuses") {
      if (!isAdminRequest(req)) return send(res, 403, { error: "管理ログインが必要です。" });
      return apiSwitchBotStatuses(res, url.searchParams.get("refresh") === "1");
    }
    if (req.method === "GET" && pathname === "/admin/switchbot/devices") {
      return isAdminRequest(req) ? apiSwitchBotDevices(res) : redirect(res, "/admin/login");
    }
    if (req.method === "POST" && pathname === "/auth/register") return registerOrganization(req, res);
    if (req.method === "POST" && pathname === "/auth/login") return passwordLogin(req, res);
    if (req.method === "POST" && pathname === "/auth/start") return startLogin(req, res);
    if (req.method === "POST" && pathname === "/api/reservations") return createReservation(req, res);
    if (req.method === "GET" && pathname === "/api/state") {
      return isAdminRequest(req) ? apiState(res) : send(res, 403, { error: "管理ログインが必要です。" });
    }
    if (req.method === "POST" && pathname === "/api/switchbot/webhook") return handleSwitchBotWebhook(req, res);

    send(res, 404, page("404", "<main class='shell'><h1>ページが見つかりません。</h1></main>"));
  } catch (error) {
    console.error(error);
    send(res, 500, { error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Facility unlock app running at http://${config.host}:${config.port}`);
  console.log(`SwitchBot mode: ${config.switchbotMock ? "MOCK (実機には登録しません)" : "REAL"}`);
  console.log(`Discord admin webhook: ${config.discordAdminWebhookUrl ? "configured" : "not configured"}`);
  console.log(`Discord organization webhook: ${config.discordOrganizationWebhookUrl ? "configured" : "not configured"}`);
});

export { renderTimeline, server };
