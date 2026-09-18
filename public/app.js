import { nextSortDirection, sortSwitchBotDevices, switchBotOrderLabel } from "/switchbot-sort.js";

document.querySelectorAll("form").forEach((form) => {
  form.addEventListener("submit", (event) => {
    const button = event.submitter instanceof HTMLButtonElement
      ? event.submitter
      : form.querySelector("button[type='submit']");
    if (button) {
      if (button.name) {
        const submittedValue = document.createElement("input");
        submittedValue.type = "hidden";
        submittedValue.name = button.name;
        submittedValue.value = button.value;
        form.append(submittedValue);
      }
      button.disabled = true;
      button.textContent = "送信中...";
    }
  });
});

const now = new Date();
const start = new Date(now.getTime() + 60 * 60 * 1000);
const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);

function toLocalInputValue(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

const startsAt = document.querySelector("input[name='startsAt']");
const endsAt = document.querySelector("input[name='endsAt']");
if (startsAt && !startsAt.value) startsAt.value = toLocalInputValue(start);
if (endsAt && !endsAt.value) endsAt.value = toLocalInputValue(end);

const roomInputs = [...document.querySelectorAll("input[name='roomIds']")];
const availableRoomInputs = roomInputs.filter((input) => !input.disabled);
const firstRoom = availableRoomInputs[0] || null;
if (firstRoom && !availableRoomInputs.some((input) => input.checked)) firstRoom.checked = true;

function updateReservationFormState() {
  const selectedCount = availableRoomInputs.filter((input) => input.checked).length;
  const selectedRoomCount = document.querySelector("[data-selected-room-count]");
  if (selectedRoomCount) selectedRoomCount.textContent = `${selectedCount}施設`;
  for (const input of roomInputs) input.required = false;
  if (!selectedCount && firstRoom) firstRoom.required = true;
}

function updateReservationDateLimits() {
  if (!startsAt || !endsAt) return;
  const minimumStart = toLocalInputValue(new Date()).slice(0, 16);
  startsAt.min = minimumStart;
  endsAt.min = startsAt.value || minimumStart;
  if (endsAt.value && startsAt.value && endsAt.value <= startsAt.value) {
    const nextEnd = new Date(new Date(startsAt.value).getTime() + 60 * 60 * 1000);
    endsAt.value = toLocalInputValue(nextEnd);
  }
}

roomInputs.forEach((input) => input.addEventListener("change", updateReservationFormState));
startsAt?.addEventListener("change", updateReservationDateLimits);
updateReservationFormState();
updateReservationDateLimits();

const timelineDayButtons = [...document.querySelectorAll("[data-timeline-day-button]")];
const timelineDays = [...document.querySelectorAll("[data-timeline-day]")];

function selectTimelineDay(index, { focus = false } = {}) {
  for (const button of timelineDayButtons) {
    const selected = button.dataset.timelineDayButton === String(index);
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  for (const day of timelineDays) {
    day.hidden = day.dataset.timelineDay !== String(index);
  }
}

timelineDayButtons.forEach((button, index) => {
  button.addEventListener("click", () => selectTimelineDay(button.dataset.timelineDayButton));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? timelineDayButtons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + timelineDayButtons.length) % timelineDayButtons.length;
    selectTimelineDay(timelineDayButtons[nextIndex].dataset.timelineDayButton, { focus: true });
  });
});

if (timelineDayButtons.length) selectTimelineDay(timelineDayButtons[0].dataset.timelineDayButton);

const adminTools = [...document.querySelectorAll("details.admin-tool")];

function openAdminToolFromHash() {
  if (!window.location.hash) return;
  let targetId = "";
  try {
    targetId = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return;
  }
  const target = document.getElementById(targetId);
  if (target instanceof HTMLDetailsElement && target.classList.contains("admin-tool")) {
    target.open = true;
  }
}

for (const tool of adminTools) {
  tool.addEventListener("toggle", () => {
    if (!tool.open) return;
    for (const other of adminTools) {
      if (other !== tool) other.open = false;
    }
  });
}

openAdminToolFromHash();
window.addEventListener("hashchange", openAdminToolFromHash);

function getFocusable(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function trapFocus(event, container) {
  if (event.key !== "Tab") return;
  const focusable = getFocusable(container);
  if (!focusable.length) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

const sidebar = document.querySelector("#admin-sidebar");
const sidebarToggle = document.querySelector("[data-admin-menu-toggle]");
const sidebarClose = document.querySelector("[data-admin-menu-close]");
const sidebarBackdrop = document.querySelector("[data-admin-sidebar-backdrop]");
let sidebarReturnFocus = null;

function openSidebar() {
  if (!sidebar || !sidebarToggle || !sidebarBackdrop) return;
  sidebarReturnFocus = document.activeElement;
  sidebarBackdrop.hidden = false;
  document.body.classList.add("admin-menu-open");
  sidebarToggle.setAttribute("aria-expanded", "true");
  sidebarClose?.focus();
}

function closeSidebar({ restoreFocus = true } = {}) {
  if (!sidebar || !sidebarToggle || !sidebarBackdrop) return;
  document.body.classList.remove("admin-menu-open");
  sidebarToggle.setAttribute("aria-expanded", "false");
  sidebarBackdrop.hidden = true;
  if (restoreFocus && sidebarReturnFocus instanceof HTMLElement) sidebarReturnFocus.focus();
}

sidebarToggle?.addEventListener("click", openSidebar);
sidebarClose?.addEventListener("click", () => closeSidebar());
sidebarBackdrop?.addEventListener("click", () => closeSidebar());
sidebar?.querySelectorAll("a[href]").forEach((link) => link.addEventListener("click", () => closeSidebar({ restoreFocus: false })));

const adminNavItems = [...document.querySelectorAll("[data-admin-nav-target]")];

function currentAdminNavTarget() {
  const hashTarget = window.location.hash.slice(1);
  return adminNavItems.some((item) => item.dataset.adminNavTarget === hashTarget) ? hashTarget : "dashboard";
}

function setActiveAdminNav(target) {
  for (const item of adminNavItems) {
    const active = item.dataset.adminNavTarget === target;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

adminNavItems.forEach((item) => item.addEventListener("click", () => {
  setActiveAdminNav(item.dataset.adminNavTarget);
}));
window.addEventListener("hashchange", () => setActiveAdminNav(currentAdminNavTarget()));
setActiveAdminNav(currentAdminNavTarget());

const switchBotPanel = document.querySelector("[data-switchbot-panel]");
const switchBotBackdrop = document.querySelector("[data-switchbot-backdrop]");
const switchBotOpenButtons = document.querySelectorAll("[data-switchbot-open]");
const switchBotClose = document.querySelector("[data-switchbot-close]");
const switchBotRefresh = document.querySelector("[data-switchbot-refresh]");
const switchBotSort = document.querySelector("[data-switchbot-sort]");
const switchBotOrder = document.querySelector("[data-switchbot-order]");
const switchBotSummary = document.querySelector("[data-switchbot-summary]");
const switchBotContent = document.querySelector("[data-switchbot-content]");
const switchBotUpdated = document.querySelector("[data-switchbot-updated]");
const switchBotSettingsLink = document.querySelector("[data-switchbot-settings-link]");
let switchBotReturnFocus = null;
let switchBotRefreshTimer = null;
let switchBotRequest = null;
let latestSwitchBotPayload = null;
let switchBotSortDirection = "asc";

function escapeMarkup(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function roleLabel(role) {
  return { keypad: "Keypad", lock: "Lock", device: "デバイス" }[role] || "デバイス";
}

function batteryLabel(device) {
  if (!Number.isFinite(device.battery)) {
    return device.availability === "unsupported" ? "API取得不可" : "取得失敗";
  }
  return `${device.battery}%`;
}

function batteryStateLabel(status) {
  return { normal: "正常", warning: "注意", low: "低下", unavailable: "取得不可" }[status] || "取得不可";
}

function renderSwitchBotDevice(device) {
  const battery = Number.isFinite(device.battery) ? Math.max(0, Math.min(100, device.battery)) : 0;
  const rooms = device.roomNames?.length ? device.roomNames.join("・") : "施設未設定";
  const meter = Number.isFinite(device.battery)
    ? `<div class="switchbot-meter" role="progressbar" aria-label="バッテリー残量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${battery}"><span style="width:${battery}%"></span></div>`
    : '<div class="switchbot-meter unavailable" aria-hidden="true"><span></span></div>';
  return `<article class="switchbot-device battery-${escapeMarkup(device.batteryStatus)}">
    <div class="switchbot-device-icon" aria-hidden="true">${device.role === "lock" ? "L" : device.role === "keypad" ? "K" : "D"}</div>
    <div class="switchbot-device-main">
      <header><div><strong>${escapeMarkup(device.deviceName)}</strong><span>${escapeMarkup(roleLabel(device.role))} · ${escapeMarkup(rooms)}</span></div><em>${escapeMarkup(batteryStateLabel(device.batteryStatus))}</em></header>
      <div class="switchbot-battery"><b>${escapeMarkup(batteryLabel(device))}</b>${meter}</div>
      <small>${escapeMarkup(device.deviceType)} · ID ${escapeMarkup(device.deviceId)}</small>
    </div>
  </article>`;
}

function renderSwitchBotGroup(title, devices, emptyMessage) {
  return `<section class="switchbot-group"><header><h3>${escapeMarkup(title)}</h3><span>${devices.length}台</span></header>${devices.length
    ? `<div class="switchbot-device-list">${devices.map(renderSwitchBotDevice).join("")}</div>`
    : `<p class="switchbot-empty">${escapeMarkup(emptyMessage)}</p>`}</section>`;
}

function renderSwitchBotStatuses(payload) {
  latestSwitchBotPayload = payload;
  const devices = sortSwitchBotDevices(
    Array.isArray(payload.devices) ? payload.devices : [],
    switchBotSort?.value || "battery",
    switchBotSortDirection
  );
  const assigned = devices.filter((device) => device.assigned);
  const unassigned = devices.filter((device) => !device.assigned);
  const lowCount = devices.filter((device) => device.batteryStatus === "low").length;
  const unavailableCount = devices.filter((device) => device.batteryStatus === "unavailable").length;
  switchBotSummary.innerHTML = `<article><span>全機器</span><strong>${devices.length}</strong></article><article><span>残量低下</span><strong>${lowCount}</strong></article><article><span>取得不可</span><strong>${unavailableCount}</strong></article>`;
  switchBotContent.innerHTML = renderSwitchBotGroup("施設設定済み", assigned, "施設に設定された機器はありません。")
    + renderSwitchBotGroup("未設定の機器", unassigned, "未設定の機器はありません。");
  const fetchedAt = new Date(payload.fetchedAt);
  switchBotUpdated.textContent = Number.isNaN(fetchedAt.getTime())
    ? "状態を取得しました"
    : `${fetchedAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} 更新 · 5分ごとに自動更新`;
}

function updateSwitchBotOrderLabel() {
  if (!switchBotOrder) return;
  const ascending = switchBotSortDirection === "asc";
  const label = switchBotOrderLabel(switchBotSort?.value || "battery", switchBotSortDirection);
  switchBotOrder.dataset.direction = switchBotSortDirection;
  switchBotOrder.textContent = `${ascending ? "↑" : "↓"} ${label}`;
  switchBotOrder.setAttribute("aria-label", `${switchBotSort?.selectedOptions[0]?.textContent || "選択項目"}を${label}で表示`);
}

async function loadSwitchBotStatuses(forceRefresh = false) {
  if (!switchBotPanel || !switchBotContent || !switchBotSummary || switchBotRequest) return;
  switchBotRefresh.disabled = true;
  switchBotRefresh.textContent = "更新中…";
  switchBotContent.setAttribute("aria-busy", "true");
  if (!switchBotContent.querySelector(".switchbot-device")) switchBotContent.innerHTML = '<p class="switchbot-empty">デバイス状態を取得しています…</p>';
  switchBotRequest = fetch(`/admin/switchbot/statuses${forceRefresh ? "?refresh=1" : ""}`, { headers: { Accept: "application/json" } });
  try {
    const response = await switchBotRequest;
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "状態を取得できませんでした。");
    renderSwitchBotStatuses(payload);
  } catch (error) {
    switchBotUpdated.textContent = "更新できませんでした";
    switchBotContent.innerHTML = `<div class="switchbot-error" role="alert"><strong>デバイス状態を取得できません</strong><p>${escapeMarkup(error.message)}</p><button class="button small" type="button" data-switchbot-retry>再試行</button></div>`;
    switchBotContent.querySelector("[data-switchbot-retry]")?.addEventListener("click", () => loadSwitchBotStatuses(true));
  } finally {
    switchBotRequest = null;
    switchBotContent.removeAttribute("aria-busy");
    switchBotRefresh.disabled = false;
    switchBotRefresh.textContent = "状態を更新";
  }
}

function openSwitchBotPanel(event) {
  if (!switchBotPanel || !switchBotBackdrop) return;
  switchBotReturnFocus = event?.currentTarget || document.activeElement;
  closeSidebar({ restoreFocus: false });
  switchBotBackdrop.hidden = false;
  switchBotPanel.setAttribute("aria-hidden", "false");
  document.body.classList.add("switchbot-panel-open");
  setActiveAdminNav("switchbot");
  switchBotClose?.focus();
  loadSwitchBotStatuses(false);
  clearInterval(switchBotRefreshTimer);
  switchBotRefreshTimer = window.setInterval(() => loadSwitchBotStatuses(false), 5 * 60 * 1000);
}

function closeSwitchBotPanel({ restoreFocus = true } = {}) {
  if (!switchBotPanel || !switchBotBackdrop) return;
  document.body.classList.remove("switchbot-panel-open");
  switchBotPanel.setAttribute("aria-hidden", "true");
  switchBotBackdrop.hidden = true;
  clearInterval(switchBotRefreshTimer);
  switchBotRefreshTimer = null;
  setActiveAdminNav(currentAdminNavTarget());
  if (restoreFocus && switchBotReturnFocus instanceof HTMLElement) switchBotReturnFocus.focus();
}

switchBotOpenButtons.forEach((button) => button.addEventListener("click", openSwitchBotPanel));
switchBotClose?.addEventListener("click", () => closeSwitchBotPanel());
switchBotBackdrop?.addEventListener("click", () => closeSwitchBotPanel());
switchBotRefresh?.addEventListener("click", () => loadSwitchBotStatuses(true));
switchBotSort?.addEventListener("change", () => {
  updateSwitchBotOrderLabel();
  if (latestSwitchBotPayload) renderSwitchBotStatuses(latestSwitchBotPayload);
});
switchBotOrder?.addEventListener("click", () => {
  switchBotSortDirection = nextSortDirection(switchBotSortDirection);
  updateSwitchBotOrderLabel();
  if (latestSwitchBotPayload) renderSwitchBotStatuses(latestSwitchBotPayload);
});
switchBotSettingsLink?.addEventListener("click", () => closeSwitchBotPanel({ restoreFocus: false }));

updateSwitchBotOrderLabel();

document.addEventListener("keydown", (event) => {
  if (document.body.classList.contains("switchbot-panel-open")) {
    if (event.key === "Escape") closeSwitchBotPanel();
    else trapFocus(event, switchBotPanel);
    return;
  }
  if (document.body.classList.contains("admin-menu-open")) {
    if (event.key === "Escape") closeSidebar();
    else trapFocus(event, sidebar);
  }
});
