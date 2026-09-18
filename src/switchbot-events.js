const LOCK_STATES = new Set(["LOCKED", "UNLOCKED", "JAMMED"]);

function normalizedDeviceId(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function eventContext(payload) {
  return payload?.context || payload?.body?.context || payload?.body || {};
}

function eventDate(value, fallback) {
  const number = Number(value);
  const milliseconds = Number.isFinite(number) && number > 0
    ? (number < 1_000_000_000_000 ? number * 1000 : number)
    : new Date(fallback).getTime();
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}

export function syncRoomLockDeviceIds(rooms, devicesRaw) {
  const devices = devicesRaw?.body?.deviceList || devicesRaw?.deviceList || [];
  const devicesById = new Map(
    devices
      .filter((device) => device?.deviceId)
      .map((device) => [normalizedDeviceId(device.deviceId), device])
  );
  let changed = false;

  for (const room of rooms || []) {
    const keypad = devicesById.get(normalizedDeviceId(room.deviceId));
    const lockDeviceId = keypad?.lockDeviceId || room.lockDeviceId || null;
    if (lockDeviceId && room.lockDeviceId !== lockDeviceId) {
      room.lockDeviceId = lockDeviceId;
      changed = true;
    }
  }

  return changed;
}

export function findRoomIdForLockDevice(rooms, deviceId, devicesRaw = null) {
  syncRoomLockDeviceIds(rooms, devicesRaw);
  const target = normalizedDeviceId(deviceId);
  return (rooms || []).find((room) => normalizedDeviceId(room.lockDeviceId) === target)?.id || null;
}

export function parseSwitchBotLockEvent(payload, {
  rooms = [],
  devicesRaw = null,
  receivedAt = new Date()
} = {}) {
  const context = eventContext(payload);
  const lockState = String(context.lockState || "").toUpperCase();
  const deviceId = context.deviceMac || context.deviceId || "";
  if (!LOCK_STATES.has(lockState) || !deviceId) return null;

  const occurredAt = eventDate(context.timeOfSample, receivedAt).toISOString();
  const batteryValue = Number(context.battery);
  const battery = Number.isFinite(batteryValue) ? Math.max(0, Math.min(100, batteryValue)) : null;
  const roomId = findRoomIdForLockDevice(rooms, deviceId, devicesRaw);

  return {
    type: "lock_state",
    deviceId: String(deviceId),
    roomId,
    lockState,
    battery,
    occurredAt,
    receivedAt: new Date(receivedAt).toISOString(),
    eventKey: `${normalizedDeviceId(deviceId)}:${occurredAt}:${lockState}`
  };
}

export function findReservationForLockEvent(db, event) {
  if (!event?.roomId || !event?.occurredAt) return null;
  const occurredAt = new Date(event.occurredAt).getTime();
  if (!Number.isFinite(occurredAt)) return null;

  const passcode = (db.passcodes || []).find((item) => (
    item.roomId === event.roomId
    && new Date(item.startsAt).getTime() <= occurredAt
    && occurredAt <= new Date(item.endsAt).getTime()
  ));
  if (passcode) {
    return (db.reservations || []).find((item) => item.id === passcode.reservationId) || null;
  }

  return (db.reservations || []).find((reservation) => {
    if (!["approved", "cancelled"].includes(reservation.status)) return false;
    const roomIds = Array.isArray(reservation.roomIds) ? reservation.roomIds : [reservation.roomId];
    return roomIds.includes(event.roomId)
      && new Date(reservation.startsAt).getTime() <= occurredAt
      && occurredAt <= new Date(reservation.endsAt).getTime();
  }) || null;
}
