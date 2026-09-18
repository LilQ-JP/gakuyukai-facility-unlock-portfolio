import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirectory = await mkdtemp(join(tmpdir(), "facility-reservation-access-"));
const dbPath = join(tempDirectory, "db.json");
const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
startsAt.setMinutes(0, 0, 0);
const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const db = {
  rooms: [{ id: "meeting-room-1", name: "会議室1", deviceId: "mock-keypad", active: true }],
  organizations: [
    { id: "org-a", name: "団体A", email: "a@example.test", representativeName: "代表A" },
    { id: "org-b", name: "団体B", email: "b@example.test", representativeName: "代表B" }
  ],
  loginTokens: [],
  sessions: [
    { id: "sid-a", organizationId: "org-a", expiresAt },
    { id: "sid-b", organizationId: "org-b", expiresAt }
  ],
  emailMessages: [],
  reservations: [
    {
      id: "reservation-a",
      publicToken: "view-org-a",
      organizationId: "org-a",
      organizationName: "団体A",
      representativeName: "代表A",
      contact: "a@example.test",
      roomId: "meeting-room-1",
      roomIds: ["meeting-room-1"],
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      purpose: "団体Aの用途",
      status: "approved",
      createdAt: new Date().toISOString()
    },
    {
      id: "reservation-b",
      publicToken: "view-org-b",
      organizationId: "org-b",
      organizationName: "団体B",
      representativeName: "代表B",
      contact: "b@example.test",
      roomId: "meeting-room-1",
      roomIds: ["meeting-room-1"],
      startsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      endsAt: new Date(endsAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      purpose: "団体Bの用途",
      status: "approved",
      createdAt: new Date().toISOString()
    },
    {
      id: "reservation-cancelled-a",
      publicToken: "view-cancelled-org-a",
      organizationId: "org-a",
      organizationName: "団体A",
      representativeName: "代表A",
      contact: "a@example.test",
      roomId: "meeting-room-1",
      roomIds: ["meeting-room-1"],
      startsAt: new Date(startsAt.getTime() + 4 * 60 * 60 * 1000).toISOString(),
      endsAt: new Date(endsAt.getTime() + 4 * 60 * 60 * 1000).toISOString(),
      purpose: "キャンセル済みの用途",
      status: "cancelled",
      cancelComment: "施設都合のため",
      cancelledAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }
  ],
  passcodes: [
    {
      id: "passcode-a",
      reservationId: "reservation-a",
      roomId: "meeting-room-1",
      status: "active",
      code: "135790",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString()
    },
    {
      id: "passcode-b",
      reservationId: "reservation-b",
      roomId: "meeting-room-1",
      status: "active",
      code: "246802",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString()
    }
  ],
  switchbotEvents: [],
  auditLogs: []
};

await writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`);
process.env.DB_PATH = dbPath;
process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.BASE_URL = "http://127.0.0.1";
process.env.ADMIN_TOKEN = "security-test-admin-token";
process.env.SWITCHBOT_MOCK = "true";

const { renderTimeline, server } = await import(`../src/server.js?reservation-access=${Date.now()}`);
if (!server.listening) await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function request(path, sid = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    headers: sid ? { Cookie: `sid=${sid}` } : {}
  });
  return { response, body: await response.text() };
}

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await rm(tempDirectory, { recursive: true, force: true });
});

test("reservation detail redirects unauthenticated visitors without exposing a passcode", async () => {
  const { response, body } = await request("/r/view-org-a");

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/login");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.includes("135790"), false);
});

test("reservation detail denies another organization without exposing reservation data", async () => {
  const { response, body } = await request("/r/view-org-a", "sid-b");

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.includes("135790"), false);
  assert.equal(body.includes("団体Aの用途"), false);
});

test("reservation detail remains available to the owning organization", async () => {
  const { response, body } = await request("/r/view-org-a", "sid-a");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.includes("135790"), true);
});

test("mypage includes only the signed-in organization's passcode and links", async () => {
  const { response, body } = await request("/mypage", "sid-b");

  assert.equal(response.status, 200);
  assert.equal(body.includes("246802"), true);
  assert.equal(body.includes("135790"), false);
  assert.equal(body.includes("/r/view-org-b"), true);
  assert.equal(body.includes("/r/view-org-a"), false);
  assert.equal(body.includes("予約あり"), true);
  assert.equal(body.includes("view-cancelled-org-a"), false);
  assert.equal(body.includes("施設都合のため"), false);
});

test("cancelled reservations do not appear in availability timelines", () => {
  const ownerTimeline = renderTimeline(db, { currentOrganizationId: "org-a" });
  const otherTimeline = renderTimeline(db, { currentOrganizationId: "org-b" });
  const adminTimeline = renderTimeline(db, { admin: true });

  assert.equal(ownerTimeline.includes("view-cancelled-org-a"), false);
  assert.equal(adminTimeline.includes("view-cancelled-org-a"), false);
  assert.equal((otherTimeline.match(/<span>予約あり<\/span>/g) || []).length, 2);
});

test("cancelled reservations are shown only to the owning organization outside the timeline", async () => {
  const owner = await request("/mypage", "sid-a");
  const other = await request("/mypage", "sid-b");

  assert.equal(owner.response.status, 200);
  assert.equal(owner.body.includes("予約のお知らせ"), true);
  assert.equal(owner.body.includes("予約がキャンセルされました"), true);
  assert.equal(owner.body.includes("施設都合のため"), true);
  assert.equal(owner.body.includes("/r/view-cancelled-org-a"), true);

  assert.equal(other.response.status, 200);
  assert.equal(other.body.includes("予約がキャンセルされました"), false);
  assert.equal(other.body.includes("施設都合のため"), false);
});
