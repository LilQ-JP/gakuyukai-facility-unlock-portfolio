import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const tempDirectory = await mkdtemp(join(tmpdir(), "facility-access-role-"));
const dbPath = join(tempDirectory, "db.json");
const adminToken = "facility-access-test-admin";
const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const initialDb = {
  rooms: [
    { id: "meeting-room-1", name: "会議室1", deviceId: "mock-meeting-room-1-keypad", active: true },
    { id: "copy-room", name: "コピー室", deviceId: "mock-copy-room-keypad", active: true }
  ],
  organizations: [
    { id: "general-org", name: "一般団体", email: "general@example.test", representativeName: "一般代表" },
    {
      id: "committee-org",
      name: "委員会",
      email: "committee@example.test",
      representativeName: "委員長",
      facilityAccessRole: "committee"
    }
  ],
  loginTokens: [],
  sessions: [
    { id: "sid-general", organizationId: "general-org", expiresAt },
    { id: "sid-committee", organizationId: "committee-org", expiresAt }
  ],
  emailMessages: [],
  reservations: [
    {
      id: "pending-copy-general",
      publicToken: "pending-copy-general-view",
      organizationId: "general-org",
      organizationName: "一般団体",
      representativeName: "一般代表",
      contact: "general@example.test",
      roomId: "copy-room",
      roomIds: ["copy-room"],
      startsAt: "2035-08-01T01:00:00.000Z",
      endsAt: "2035-08-01T02:00:00.000Z",
      purpose: "コピー作業",
      status: "pending",
      createdAt: new Date().toISOString()
    },
    {
      id: "approved-copy-committee",
      publicToken: "approved-copy-committee-view",
      organizationId: "committee-org",
      organizationName: "委員会",
      representativeName: "委員長",
      contact: "committee@example.test",
      roomId: "copy-room",
      roomIds: ["copy-room"],
      startsAt: "2035-08-02T01:00:00.000Z",
      endsAt: "2035-08-02T02:00:00.000Z",
      purpose: "委員会作業",
      status: "approved",
      approvedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    }
  ],
  passcodes: [],
  switchbotEvents: [],
  auditLogs: []
};

await writeFile(dbPath, `${JSON.stringify(initialDb, null, 2)}\n`);
process.env.DB_PATH = dbPath;
process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.BASE_URL = "http://127.0.0.1";
process.env.ADMIN_TOKEN = adminToken;
process.env.SWITCHBOT_MOCK = "true";
process.env.EMAIL_MODE = "log";
process.env.DISCORD_ADMIN_WEBHOOK_URL = "disabled";
process.env.DISCORD_ORGANIZATION_WEBHOOK_URL = "disabled";

const { server } = await import(`../src/server.js?facility-access=${Date.now()}`);
if (!server.listening) await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const adminCookie = `admin=${crypto.createHash("sha256").update(adminToken).digest("hex")}`;

async function request(path, { sid = null, admin = false, method = "GET", body = null, json = false } = {}) {
  const headers = {};
  if (sid) headers.Cookie = `sid=${sid}`;
  if (admin) headers.Cookie = adminCookie;
  if (body) headers["Content-Type"] = json ? "application/json" : "application/x-www-form-urlencoded";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: "manual",
    headers,
    body: body ? (json ? JSON.stringify(body) : new URLSearchParams(body)) : null
  });
  return { response, body: await response.text() };
}

async function readDb() {
  return JSON.parse(await readFile(dbPath, "utf8"));
}

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await rm(tempDirectory, { recursive: true, force: true });
});

test("reservation page disables the copy room for general organizations only", async () => {
  const general = await request("/reserve", { sid: "sid-general" });
  const committee = await request("/reserve", { sid: "sid-committee" });

  assert.equal(general.response.status, 200);
  assert.match(general.body, /value="copy-room"[^>]*disabled/);
  assert.equal(general.body.includes("委員会のみ利用できます"), true);
  assert.equal(committee.response.status, 200);
  assert.doesNotMatch(committee.body, /value="copy-room"[^>]*disabled/);
});

test("reservation API rejects a direct copy-room request from a general organization", async () => {
  const result = await request("/api/reservations", {
    sid: "sid-general",
    method: "POST",
    json: true,
    body: {
      roomIds: ["copy-room"],
      representativeName: "一般代表",
      startsAt: "2035-08-03T10:00",
      endsAt: "2035-08-03T11:00",
      purpose: "直接API申請"
    }
  });
  const payload = JSON.parse(result.body);
  const db = await readDb();

  assert.equal(result.response.status, 403);
  assert.equal(payload.error.includes("委員会のみ予約できます"), true);
  assert.equal(db.reservations.some((reservation) => reservation.purpose === "直接API申請"), false);
});

test("admin cannot approve a pending copy-room request while the organization is general", async () => {
  const result = await request("/admin/reservations/pending-copy-general/approve", {
    admin: true,
    method: "POST"
  });
  const db = await readDb();
  const reservation = db.reservations.find((item) => item.id === "pending-copy-general");

  assert.equal(result.response.status, 400);
  assert.equal(result.body.includes("委員会だけ承認できます"), true);
  assert.equal(reservation.status, "pending");
  assert.equal(db.passcodes.some((passcode) => passcode.reservationId === reservation.id), false);
});

test("admin can change an organization to committee and then approve its copy-room request", async () => {
  const update = await request("/admin/organizations/general-org/access-role", {
    admin: true,
    method: "POST",
    body: { facilityAccessRole: "committee" }
  });
  let db = await readDb();

  assert.equal(update.response.status, 302);
  assert.equal(update.response.headers.get("location"), "/admin?organizationStatus=access-updated#requests");
  assert.equal(db.organizations.find((organization) => organization.id === "general-org").facilityAccessRole, "committee");
  assert.equal(db.auditLogs.some((log) => (
    log.action === "organization.access_role_updated"
    && log.details.organizationId === "general-org"
    && log.details.previousRole === "general"
    && log.details.nextRole === "committee"
  )), true);

  const approval = await request("/admin/reservations/pending-copy-general/approve", {
    admin: true,
    method: "POST"
  });
  db = await readDb();
  const reservation = db.reservations.find((item) => item.id === "pending-copy-general");

  assert.equal(approval.response.status, 302);
  assert.equal(reservation.status, "approved");
  assert.equal(db.passcodes.some((passcode) => passcode.reservationId === reservation.id && passcode.status === "active"), true);
});

test("downgrading a committee preserves its already approved copy-room reservation", async () => {
  const update = await request("/admin/organizations/committee-org/access-role", {
    admin: true,
    method: "POST",
    body: { facilityAccessRole: "general" }
  });
  const db = await readDb();

  assert.equal(update.response.status, 302);
  assert.equal(db.organizations.find((organization) => organization.id === "committee-org").facilityAccessRole, "general");
  assert.equal(db.reservations.find((reservation) => reservation.id === "approved-copy-committee").status, "approved");
});

test("new registrations default to general and re-registration preserves an assigned role", async () => {
  const registration = await request("/auth/register", {
    method: "POST",
    body: {
      name: "新規団体",
      representativeName: "新規代表",
      email: "new@example.test",
      password: "new-password-123",
      passwordConfirm: "new-password-123"
    }
  });
  let db = await readDb();

  assert.equal(registration.response.status, 302);
  assert.equal(db.organizations.find((organization) => organization.email === "new@example.test").facilityAccessRole, "general");

  await request("/auth/register", {
    method: "POST",
    body: {
      name: "一般団体 更新",
      representativeName: "一般代表 更新",
      email: "general@example.test",
      password: "updated-password-123",
      passwordConfirm: "updated-password-123"
    }
  });
  db = await readDb();

  assert.equal(db.organizations.find((organization) => organization.id === "general-org").facilityAccessRole, "committee");
});
