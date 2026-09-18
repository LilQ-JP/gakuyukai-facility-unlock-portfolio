import test from "node:test";
import assert from "node:assert/strict";
import {
  findReservationForLockEvent,
  parseSwitchBotLockEvent,
  syncRoomLockDeviceIds
} from "../src/switchbot-events.js";

const devicesRaw = {
  body: {
    deviceList: [{
      deviceId: "keypad-a",
      deviceType: "Keypad Touch",
      lockDeviceId: "AA:BB:CC:DD"
    }]
  }
};

test("lock webhook is normalized and mapped from Keypad to its room", () => {
  const rooms = [{ id: "room-a", name: "会議室", deviceId: "keypad-a" }];
  const event = parseSwitchBotLockEvent({
    eventType: "changeReport",
    context: {
      deviceType: "WoLock",
      deviceMac: "AABBCCDD",
      lockState: "UNLOCKED",
      battery: 78,
      timeOfSample: 1785297600
    }
  }, {
    rooms,
    devicesRaw,
    receivedAt: new Date("2026-07-29T03:00:10.000Z")
  });

  assert.equal(event.roomId, "room-a");
  assert.equal(event.lockState, "UNLOCKED");
  assert.equal(event.battery, 78);
  assert.equal(event.occurredAt, "2026-07-29T04:00:00.000Z");
  assert.equal(rooms[0].lockDeviceId, "AA:BB:CC:DD");
});

test("non-lock webhook does not create a physical lock event", () => {
  const event = parseSwitchBotLockEvent({
    context: {
      deviceType: "WoKeypad",
      deviceMac: "keypad-a",
      eventName: "createKey",
      result: "success"
    }
  });

  assert.equal(event, null);
});

test("room Lock IDs are updated without changing Keypad IDs", () => {
  const rooms = [{ id: "room-a", deviceId: "keypad-a" }];
  assert.equal(syncRoomLockDeviceIds(rooms, devicesRaw), true);
  assert.equal(rooms[0].deviceId, "keypad-a");
  assert.equal(rooms[0].lockDeviceId, "AA:BB:CC:DD");
  assert.equal(syncRoomLockDeviceIds(rooms, devicesRaw), false);
});

test("reservation attribution uses the active passcode window", () => {
  const event = {
    roomId: "room-a",
    occurredAt: "2026-07-29T04:00:00.000Z"
  };
  const db = {
    passcodes: [{
      roomId: "room-a",
      reservationId: "reservation-a",
      startsAt: "2026-07-29T03:50:00.000Z",
      endsAt: "2026-07-29T05:10:00.000Z"
    }],
    reservations: [{ id: "reservation-a", organizationName: "テスト団体" }]
  };

  assert.equal(findReservationForLockEvent(db, event)?.id, "reservation-a");
});
