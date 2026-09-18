import crypto from "node:crypto";
import { config } from "./config.js";

const deviceStatusCache = new Map();
const DEVICE_STATUS_CACHE_MS = 5 * 60 * 1000;

function makePasscode() {
  return String(crypto.randomInt(100000, 999999));
}

function unixSeconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function makeHeaders() {
  const nonce = crypto.randomUUID();
  const t = Date.now().toString();
  const sign = crypto
    .createHmac("sha256", config.switchbotSecret)
    .update(`${config.switchbotToken}${t}${nonce}`)
    .digest("base64");

  return {
    Authorization: config.switchbotToken,
    sign,
    nonce,
    t,
    "Content-Type": "application/json"
  };
}

function extractCommandId(raw) {
  return raw.body?.commandId
    || raw.body?.command_id
    || raw.context?.commandId
    || raw.context?.command_id
    || raw.commandId
    || raw.command_id
    || null;
}

function extractKeyId(raw) {
  return raw.body?.id
    || raw.body?.keyId
    || raw.body?.keyID
    || raw.body?.key_id
    || raw.id
    || raw.keyId
    || raw.keyID
    || raw.key_id
    || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findKeyByName(deviceId, name, attempts = 15, intervalMs = 3000) {
  for (let index = 0; index < attempts; index += 1) {
    if (index > 0) await sleep(intervalMs);
    const devices = await getSwitchBotDevices();
    const device = (devices.body?.deviceList || []).find((item) => item.deviceId === deviceId);
    const key = (device?.keyList || []).find((item) => item.name === name);
    if (key) return key;
  }
  return null;
}

export async function getSwitchBotDevices() {
  if (config.switchbotMock) {
    return {
      statusCode: 100,
      body: {
        deviceList: [
          { deviceId: "mock-meeting-room-1-keypad", deviceName: "会議室1 Keypad", deviceType: "Keypad Touch", lockDeviceId: "mock-meeting-room-1-lock" },
          { deviceId: "mock-meeting-room-2-keypad", deviceName: "会議室2 Keypad", deviceType: "Keypad Touch", lockDeviceId: "mock-meeting-room-2-lock" },
          { deviceId: "mock-copy-room-keypad", deviceName: "コピー室 Keypad", deviceType: "Keypad Touch", lockDeviceId: "mock-copy-room-lock" }
        ],
        infraredRemoteList: []
      }
    };
  }

  if (!config.switchbotToken || !config.switchbotSecret) {
    throw new Error("SwitchBot credentials are missing. Set SWITCHBOT_TOKEN and SWITCHBOT_SECRET.");
  }

  const response = await fetch("https://api.switch-bot.com/v1.1/devices", {
    method: "GET",
    headers: makeHeaders()
  });
  const raw = await response.json();
  if (!response.ok || raw.statusCode !== 100) {
    throw new Error(`SwitchBot device list failed: ${JSON.stringify(raw)}`);
  }
  return raw;
}

export async function getSwitchBotDeviceStatus(deviceId) {
  if (config.switchbotMock) {
    const isKeypad = String(deviceId).includes("keypad");
    return {
      statusCode: 100,
      body: {
        deviceId,
        deviceType: isKeypad ? "Keypad Touch" : "Smart Lock",
        battery: isKeypad ? null : 100
      }
    };
  }

  if (!config.switchbotToken || !config.switchbotSecret) {
    throw new Error("SwitchBot credentials are missing. Set SWITCHBOT_TOKEN and SWITCHBOT_SECRET.");
  }

  const response = await fetch(`https://api.switch-bot.com/v1.1/devices/${deviceId}/status`, {
    method: "GET",
    headers: makeHeaders()
  });
  const raw = await response.json();
  if (!response.ok || raw.statusCode !== 100) {
    throw new Error(`SwitchBot device status failed: ${JSON.stringify(raw)}`);
  }
  return raw;
}

function batteryValue(raw) {
  const value = raw?.body?.battery ?? raw?.battery;
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function getCachedDeviceStatus(deviceId, { forceRefresh = false } = {}) {
  const cached = deviceStatusCache.get(deviceId);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < DEVICE_STATUS_CACHE_MS) return cached.raw;
  const raw = await getSwitchBotDeviceStatus(deviceId);
  deviceStatusCache.set(deviceId, { raw, fetchedAt: Date.now() });
  return raw;
}

async function readBattery(deviceId, { forceRefresh = false } = {}) {
  if (!deviceId) return { battery: null, error: "deviceId未設定" };
  try {
    return { battery: batteryValue(await getCachedDeviceStatus(deviceId, { forceRefresh })), error: "" };
  } catch (error) {
    return { battery: null, error: error.message };
  }
}

function deviceRole(device) {
  const type = String(device.deviceType || "").toLowerCase();
  if (type.includes("keypad")) return "keypad";
  if (type.includes("lock")) return "lock";
  return "device";
}

export function batteryStatus(value) {
  if (!Number.isFinite(value)) return "unavailable";
  if (value < 20) return "low";
  if (value < 50) return "warning";
  return "normal";
}

export async function getAllDeviceBatteryStatuses(rooms, { forceRefresh = false, devicesRaw = null } = {}) {
  const fetchedAt = new Date();
  const devices = devicesRaw || await getSwitchBotDevices();
  const deviceMap = new Map();

  for (const device of devices.body?.deviceList || []) {
    if (device?.deviceId) deviceMap.set(device.deviceId, { ...device });
  }

  // LockはdeviceListに含まれないことがあるため、Keypadの参照先も一覧へ統合します。
  for (const device of deviceMap.values()) {
    if (device.lockDeviceId && !deviceMap.has(device.lockDeviceId)) {
      deviceMap.set(device.lockDeviceId, {
        deviceId: device.lockDeviceId,
        deviceName: `${device.deviceName || "Keypad"} のLock`,
        deviceType: "Smart Lock",
        linkedKeypadId: device.deviceId
      });
    }
  }

  // 設定済みdeviceIdがAPI一覧に出ない場合も、紐付け不備を確認できるよう残します。
  for (const room of rooms || []) {
    if (room.deviceId && !deviceMap.has(room.deviceId)) {
      deviceMap.set(room.deviceId, {
        deviceId: room.deviceId,
        deviceName: `${room.name} Keypad`,
        deviceType: "Keypad",
        configuredOnly: true
      });
    }
  }

  const roomByDeviceId = new Map();
  for (const room of rooms || []) {
    if (room.deviceId) roomByDeviceId.set(room.deviceId, room);
  }

  const normalizedDevices = await Promise.all([...deviceMap.values()].map(async (device) => {
    const keypadRoom = roomByDeviceId.get(device.deviceId);
    const linkedKeypad = [...deviceMap.values()].find((item) => item.lockDeviceId === device.deviceId);
    const linkedRoom = linkedKeypad ? roomByDeviceId.get(linkedKeypad.deviceId) : null;
    const room = keypadRoom || linkedRoom || null;
    const status = await readBattery(device.deviceId, { forceRefresh });
    const role = deviceRole(device);
    const availability = status.error
      ? "unavailable"
      : Number.isFinite(status.battery) ? "available" : "unsupported";

    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName || "名称未設定",
      deviceType: device.deviceType || "種類不明",
      role,
      roomIds: room ? [room.id] : [],
      roomNames: room ? [room.name] : [],
      assigned: Boolean(room),
      linkedDeviceId: role === "keypad" ? device.lockDeviceId || null : linkedKeypad?.deviceId || device.linkedKeypadId || null,
      battery: status.battery,
      batteryStatus: batteryStatus(status.battery),
      availability
    };
  }));

  normalizedDevices.sort((a, b) => Number(b.assigned) - Number(a.assigned)
    || a.roomNames.join("").localeCompare(b.roomNames.join(""), "ja")
    || a.deviceName.localeCompare(b.deviceName, "ja"));

  return {
    fetchedAt: fetchedAt.toISOString(),
    cacheExpiresAt: new Date(fetchedAt.getTime() + DEVICE_STATUS_CACHE_MS).toISOString(),
    devices: normalizedDevices
  };
}

export async function getRoomBatteryStatuses(rooms, devicesRaw = null) {
  const devices = devicesRaw || await getSwitchBotDevices();
  const deviceList = devices.body?.deviceList || [];
  return Promise.all((rooms || []).map(async (room) => {
    const keypad = deviceList.find((device) => device.deviceId === room.deviceId) || null;
    const lockDeviceId = keypad?.lockDeviceId || null;
    const [keypadStatus, lockStatus] = await Promise.all([
      readBattery(room.deviceId),
      readBattery(lockDeviceId)
    ]);
    return {
      roomId: room.id,
      roomName: room.name,
      keypadName: keypad?.deviceName || "Keypad",
      keypadBattery: keypadStatus.battery,
      keypadError: keypadStatus.error,
      lockDeviceId,
      lockBattery: lockStatus.battery,
      lockError: lockStatus.error
    };
  }));
}

export async function createTemporaryPasscode({ room, reservation, code: requestedCode = null }) {
  const code = requestedCode || makePasscode();
  const bufferedStartsAt = new Date(reservation.startsAt).getTime() - config.startBufferMinutes * 60 * 1000;
  const bufferedEndsAt = new Date(reservation.endsAt).getTime() + config.endBufferMinutes * 60 * 1000;
  const minimumStartsAt = Date.now() + 60 * 1000;
  const safeStartsAt = Math.max(bufferedStartsAt, minimumStartsAt);
  if (bufferedEndsAt <= safeStartsAt) {
    throw new Error("SwitchBot passcode window is already expired or too short to issue.");
  }
  const startsAt = new Date(safeStartsAt).toISOString();
  const endsAt = new Date(bufferedEndsAt).toISOString();
  const scheduleWarning = safeStartsAt !== bufferedStartsAt
    ? "開始時刻が過去にならないよう、SwitchBot登録用の開始時刻を現在時刻の約1分後に補正しました。"
    : "";

  if (config.switchbotMock) {
    return {
      status: "active",
      code,
      startsAt,
      endsAt,
      commandId: `mock_${crypto.randomBytes(6).toString("hex")}`,
      keyId: `mock_key_${crypto.randomBytes(6).toString("hex")}`,
      raw: { mock: true }
    };
  }

  if (!config.switchbotToken || !config.switchbotSecret) {
    throw new Error("SwitchBot credentials are missing. Set SWITCHBOT_TOKEN and SWITCHBOT_SECRET.");
  }

  const keyName = `${reservation.organizationName}-${reservation.id}`.slice(0, 32);
  const response = await fetch(`https://api.switch-bot.com/v1.1/devices/${room.deviceId}/commands`, {
    method: "POST",
    headers: makeHeaders(),
    body: JSON.stringify({
      command: "createKey",
      parameter: {
        name: keyName,
        type: "timeLimit",
        password: code,
        startTime: unixSeconds(startsAt),
        endTime: unixSeconds(endsAt)
      },
      commandType: "command"
    })
  });

  const raw = await response.json();
  if (!response.ok || raw.statusCode !== 100) {
    throw new Error(`SwitchBot createKey failed: ${JSON.stringify(raw)}`);
  }

  const commandId = extractCommandId(raw);
  let keyId = extractKeyId(raw);
  let keyLookup = null;
  if (!keyId) {
    keyLookup = await findKeyByName(room.deviceId, keyName);
    keyId = keyLookup?.id || null;
  }
  return {
    status: "active",
    code,
    startsAt,
    endsAt,
    commandId,
    keyId: keyId ? String(keyId) : null,
    warning: [scheduleWarning, keyId ? "" : "SwitchBot accepted createKey, but passcode id was not found in keyList. Deletion may require the SwitchBot app."]
      .filter(Boolean)
      .join(" "),
    raw,
    keyLookup
  };
}

export async function deleteTemporaryPasscode({ room, passcode }) {
  const keyId = passcode.keyId || passcode.passcodeId || null;
  if (!keyId) {
    return {
      status: "manual_required",
      message: "SwitchBot passcode id is missing.",
      raw: null
    };
  }

  if (config.switchbotMock) {
    return {
      status: "deleted",
      keyId,
      commandId: `mock_delete_${crypto.randomBytes(6).toString("hex")}`,
      raw: { mock: true }
    };
  }

  if (!config.switchbotToken || !config.switchbotSecret) {
    throw new Error("SwitchBot credentials are missing. Set SWITCHBOT_TOKEN and SWITCHBOT_SECRET.");
  }

  const response = await fetch(`https://api.switch-bot.com/v1.1/devices/${room.deviceId}/commands`, {
    method: "POST",
    headers: makeHeaders(),
    body: JSON.stringify({
      command: "deleteKey",
      parameter: {
        id: keyId
      },
      commandType: "command"
    })
  });

  const raw = await response.json();
  if (!response.ok || raw.statusCode !== 100) {
    throw new Error(`SwitchBot deleteKey failed: ${JSON.stringify(raw)}`);
  }

  return {
    status: "deleted",
    keyId,
    commandId: raw.body?.commandId || raw.commandId || null,
    raw
  };
}
