import test from "node:test";
import assert from "node:assert/strict";
import {
  canOrganizationReserveRoom,
  facilityAccessRole,
  hashPassword,
  hasRoomConflict,
  isAnnualOrganizationResetDate,
  normalizeDb,
  resetOrganizationsForAcademicYear,
  verifyPassword
} from "../src/store.js";

test("hasRoomConflict detects overlapping reservations", () => {
  const db = {
    reservations: [
      {
        id: "a",
        roomId: "meeting-room",
        startsAt: "2026-07-10T10:00:00.000Z",
        endsAt: "2026-07-10T11:00:00.000Z",
        status: "approved"
      }
    ]
  };

  assert.equal(
    hasRoomConflict(db, "meeting-room", "2026-07-10T10:30:00.000Z", "2026-07-10T11:30:00.000Z"),
    true
  );
  assert.equal(
    hasRoomConflict(db, "meeting-room", "2026-07-10T11:00:00.000Z", "2026-07-10T12:00:00.000Z"),
    false
  );
  assert.equal(
    hasRoomConflict(db, "storage", "2026-07-10T10:30:00.000Z", "2026-07-10T11:30:00.000Z"),
    false
  );
});

test("hashPassword stores a salted hash and verifyPassword checks it", () => {
  const passwordHash = hashPassword("circle-password-123");

  assert.notEqual(passwordHash, "circle-password-123");
  assert.equal(passwordHash.startsWith("pbkdf2_sha256$"), true);
  assert.equal(verifyPassword("circle-password-123", passwordHash), true);
  assert.equal(verifyPassword("wrong-password", passwordHash), false);
});

test("hasRoomConflict detects overlaps across multi-room reservations", () => {
  const db = {
    reservations: [
      {
        id: "a",
        roomIds: ["meeting-room-1", "meeting-room-2"],
        startsAt: "2026-07-10T10:00:00.000Z",
        endsAt: "2026-07-10T11:00:00.000Z",
        status: "pending"
      }
    ]
  };

  assert.equal(
    hasRoomConflict(db, ["meeting-room-2"], "2026-07-10T10:15:00.000Z", "2026-07-10T10:45:00.000Z"),
    true
  );
  assert.equal(
    hasRoomConflict(db, ["storage"], "2026-07-10T10:15:00.000Z", "2026-07-10T10:45:00.000Z"),
    false
  );
});

test("hasRoomConflict ignores rejected and cancelled reservations", () => {
  const db = {
    reservations: [
      {
        id: "a",
        roomIds: ["meeting-room-1"],
        startsAt: "2026-07-10T10:00:00.000Z",
        endsAt: "2026-07-10T11:00:00.000Z",
        status: "rejected"
      },
      {
        id: "b",
        roomIds: ["meeting-room-2"],
        startsAt: "2026-07-10T10:00:00.000Z",
        endsAt: "2026-07-10T11:00:00.000Z",
        status: "cancelled"
      }
    ]
  };

  assert.equal(
    hasRoomConflict(db, ["meeting-room-1", "meeting-room-2"], "2026-07-10T10:15:00.000Z", "2026-07-10T10:45:00.000Z"),
    false
  );
});

test("annual organization reset is available only on March 31 in Japan", () => {
  assert.equal(isAnnualOrganizationResetDate(new Date("2027-03-30T15:00:00.000Z")), true);
  assert.equal(isAnnualOrganizationResetDate(new Date("2027-03-30T14:59:59.000Z")), false);
  assert.equal(isAnnualOrganizationResetDate(new Date("2027-03-31T14:59:59.000Z")), true);
  assert.equal(isAnnualOrganizationResetDate(new Date("2027-03-31T15:00:00.000Z")), false);
});

test("annual organization reset removes accounts but retains reservation and audit history", () => {
  const db = {
    organizations: [{ id: "org_1" }, { id: "org_2" }],
    sessions: [{ id: "sid_1", organizationId: "org_1" }, { id: "sid_other", organizationId: "other" }],
    loginTokens: [{ id: "token_1", organizationId: "org_2" }],
    reservations: [{ id: "res_1", organizationId: "org_1", updatedAt: "old" }],
    passcodes: [{ id: "pass_1", reservationId: "res_1" }],
    auditLogs: [{ id: "audit_1" }]
  };
  const resetAt = new Date("2027-03-31T03:00:00.000Z");
  const result = resetOrganizationsForAcademicYear(db, resetAt);

  assert.equal(result.organizationCount, 2);
  assert.deepEqual(db.organizations, []);
  assert.deepEqual(db.sessions, [{ id: "sid_other", organizationId: "other" }]);
  assert.deepEqual(db.loginTokens, []);
  assert.equal(db.reservations.length, 1);
  assert.equal(db.reservations[0].organizationDeletedAt, resetAt.toISOString());
  assert.equal(db.passcodes.length, 1);
  assert.equal(db.auditLogs.length, 1);
});

test("normalizeDb adds SwitchBot event history without removing existing data", () => {
  const db = normalizeDb({
    rooms: [{ id: "room-1", name: "会議室", deviceId: "keypad-1" }],
    reservations: [{ id: "reservation-1", roomId: "room-1" }],
    auditLogs: [{ id: "audit-1" }]
  });

  assert.deepEqual(db.switchbotEvents, []);
  assert.equal(db.reservations[0].id, "reservation-1");
  assert.equal(db.auditLogs[0].id, "audit-1");
  assert.equal(db.rooms.find((room) => room.id === "room-1").lockDeviceId, null);
});

test("normalizeDb defaults existing organizations to general and preserves committee access", () => {
  const db = normalizeDb({
    organizations: [
      { id: "legacy-org" },
      { id: "committee-org", facilityAccessRole: "committee" },
      { id: "invalid-org", facilityAccessRole: "invalid" }
    ]
  });

  assert.equal(facilityAccessRole(db.organizations[0]), "general");
  assert.equal(facilityAccessRole(db.organizations[1]), "committee");
  assert.equal(facilityAccessRole(db.organizations[2]), "general");
});

test("only committee organizations can reserve the copy room", () => {
  const meetingRoom = { id: "meeting-room-1" };
  const copyRoom = { id: "copy-room" };
  const generalOrganization = { facilityAccessRole: "general" };
  const committeeOrganization = { facilityAccessRole: "committee" };

  assert.equal(canOrganizationReserveRoom(generalOrganization, meetingRoom), true);
  assert.equal(canOrganizationReserveRoom(generalOrganization, copyRoom), false);
  assert.equal(canOrganizationReserveRoom(committeeOrganization, copyRoom), true);
});
