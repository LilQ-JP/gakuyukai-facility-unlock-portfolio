import test from "node:test";
import assert from "node:assert/strict";

process.env.SWITCHBOT_MOCK = "true";

const {
  batteryStatus,
  deleteTemporaryPasscode,
  getAllDeviceBatteryStatuses,
  getCachedDeviceStatus,
  getRoomBatteryStatuses
} = await import(`../src/switchbot.js?test=${Date.now()}`);

test("deleteTemporaryPasscode asks for manual deletion when passcode id is missing", async () => {
  const result = await deleteTemporaryPasscode({
    room: { id: "meeting-room-1", deviceId: "mock-keypad" },
    passcode: { id: "pass_1", keyId: null }
  });

  assert.equal(result.status, "manual_required");
});

test("deleteTemporaryPasscode deletes by key id in mock mode", async () => {
  const result = await deleteTemporaryPasscode({
    room: { id: "meeting-room-1", deviceId: "mock-keypad" },
    passcode: { id: "pass_1", keyId: "key_123" }
  });

  assert.equal(result.status, "deleted");
  assert.equal(result.keyId, "key_123");
  assert.match(result.commandId, /^mock_delete_/);
});

test("getRoomBatteryStatuses reports paired lock battery and tolerates missing keypad battery", async () => {
  const [result] = await getRoomBatteryStatuses([
    { id: "meeting-room-1", name: "会議室1", deviceId: "mock-meeting-room-1-keypad" }
  ]);

  assert.equal(result.roomName, "会議室1");
  assert.equal(result.keypadBattery, null);
  assert.equal(result.lockBattery, 100);
});

test("getAllDeviceBatteryStatuses merges paired locks, removes duplicates and maps facilities", async () => {
  const result = await getAllDeviceBatteryStatuses([
    { id: "meeting-room-1", name: "会議室1", deviceId: "mock-room-keypad" }
  ], {
    devicesRaw: {
      body: {
        deviceList: [
          { deviceId: "mock-room-keypad", deviceName: "会議室1 Keypad", deviceType: "Keypad Touch", lockDeviceId: "mock-room-lock" },
          { deviceId: "mock-room-lock", deviceName: "会議室1 Lock", deviceType: "Smart Lock" },
          { deviceId: "mock-unassigned-lock", deviceName: "予備Lock", deviceType: "Smart Lock" }
        ]
      }
    }
  });

  assert.equal(result.devices.length, 3);
  assert.match(result.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(new Date(result.cacheExpiresAt) > new Date(result.fetchedAt));

  const keypad = result.devices.find((device) => device.deviceId === "mock-room-keypad");
  const lock = result.devices.find((device) => device.deviceId === "mock-room-lock");
  const unassigned = result.devices.find((device) => device.deviceId === "mock-unassigned-lock");
  assert.deepEqual(keypad.roomNames, ["会議室1"]);
  assert.equal(keypad.batteryStatus, "unavailable");
  assert.equal(keypad.availability, "unsupported");
  assert.equal(lock.assigned, true);
  assert.equal(lock.battery, 100);
  assert.equal(lock.batteryStatus, "normal");
  assert.equal(unassigned.assigned, false);
});

test("getAllDeviceBatteryStatuses keeps configured devices missing from the API list", async () => {
  const result = await getAllDeviceBatteryStatuses([
    { id: "copy-room", name: "コピー室", deviceId: "mock-missing-keypad" }
  ], { devicesRaw: { body: { deviceList: [] } }, forceRefresh: true });

  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].assigned, true);
  assert.deepEqual(result.devices[0].roomIds, ["copy-room"]);
});

test("batteryStatus follows the normal, warning and low thresholds", () => {
  assert.equal(batteryStatus(50), "normal");
  assert.equal(batteryStatus(49), "warning");
  assert.equal(batteryStatus(20), "warning");
  assert.equal(batteryStatus(19), "low");
  assert.equal(batteryStatus(null), "unavailable");
});

test("getCachedDeviceStatus reuses cache and force refresh bypasses it", async () => {
  const cachedFirst = await getCachedDeviceStatus("mock-cache-lock");
  const cachedSecond = await getCachedDeviceStatus("mock-cache-lock");
  const refreshed = await getCachedDeviceStatus("mock-cache-lock", { forceRefresh: true });

  assert.strictEqual(cachedSecond, cachedFirst);
  assert.notStrictEqual(refreshed, cachedFirst);
});
