import test from "node:test";
import assert from "node:assert/strict";
import { makeReservationStatusEmail } from "../src/email.js";

const baseInput = {
  organization: { name: "テスト団体", email: "test@example.com" },
  reservation: {
    startsAt: "2026-07-20T01:00:00.000Z",
    endsAt: "2026-07-20T02:00:00.000Z"
  },
  rooms: [{ id: "meeting-room-1", name: "会議室1" }]
};

test("approved reservation email includes active passcode and its validity period", () => {
  const email = makeReservationStatusEmail({
    ...baseInput,
    statusLabel: "承認済み",
    passcodes: [{
      roomId: "meeting-room-1",
      code: "123456",
      status: "active",
      startsAt: "2026-07-20T00:50:00.000Z",
      endsAt: "2026-07-20T02:10:00.000Z"
    }]
  });

  assert.match(email.text, /会議室1: 123456/);
  assert.match(email.text, /有効期間:/);
});

test("rejected reservation email does not include a passcode", () => {
  const email = makeReservationStatusEmail({
    ...baseInput,
    statusLabel: "却下",
    passcodes: [{ roomId: "meeting-room-1", code: "123456", status: "active" }]
  });

  assert.doesNotMatch(email.text, /123456/);
});
