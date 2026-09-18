import test from "node:test";
import assert from "node:assert/strict";
import {
  nextSortDirection,
  sortSwitchBotDevices,
  switchBotOrderLabel
} from "../public/switchbot-sort.js";

const devices = [
  { deviceId: "a", deviceName: "Lock A", deviceType: "Smart Lock", roomNames: ["会議室A"], battery: 75 },
  { deviceId: "b", deviceName: "Lock B", deviceType: "Smart Lock", roomNames: ["会議室B"], battery: 15 },
  { deviceId: "c", deviceName: "Keypad C", deviceType: "Keypad", roomNames: ["会議室C"], battery: null }
];

test("sortSwitchBotDevices sorts batteries in both directions and keeps unavailable last", () => {
  assert.deepEqual(sortSwitchBotDevices(devices, "battery", "asc").map((device) => device.deviceId), ["b", "a", "c"]);
  assert.deepEqual(sortSwitchBotDevices(devices, "battery", "desc").map((device) => device.deviceId), ["a", "b", "c"]);
});

test("sortSwitchBotDevices switches name and facility ordering", () => {
  assert.deepEqual(sortSwitchBotDevices(devices, "name", "asc").map((device) => device.deviceId), ["c", "a", "b"]);
  assert.deepEqual(sortSwitchBotDevices(devices, "facility", "desc").map((device) => device.deviceId), ["c", "b", "a"]);
});

test("sorting controls switch direction and use clear Japanese labels", () => {
  assert.equal(nextSortDirection("asc"), "desc");
  assert.equal(nextSortDirection("desc"), "asc");
  assert.equal(switchBotOrderLabel("battery", "asc"), "少ない順");
  assert.equal(switchBotOrderLabel("battery", "desc"), "多い順");
  assert.equal(switchBotOrderLabel("name", "desc"), "降順");
});
