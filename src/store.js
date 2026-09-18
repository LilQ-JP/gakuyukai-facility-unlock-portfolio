import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "..", "data", "db.json");

export const FACILITY_ACCESS_ROLES = new Set(["general", "committee"]);
export const COMMITTEE_ONLY_ROOM_IDS = new Set(["copy-room"]);

const defaultDb = {
  rooms: [
    {
      id: "meeting-room-1",
      name: "会議室1",
      deviceId: "mock-meeting-room-1-keypad",
      active: true
    },
    {
      id: "meeting-room-2",
      name: "会議室2",
      deviceId: "mock-meeting-room-2-keypad",
      active: true
    },
    {
      id: "copy-room",
      name: "コピー室",
      deviceId: "mock-copy-room-keypad",
      active: true
    }
  ],
  organizations: [],
  loginTokens: [],
  sessions: [],
  emailMessages: [],
  reservations: [],
  passcodes: [],
  switchbotEvents: [],
  auditLogs: []
};

let dbCache;

export function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function publicReservation(reservation) {
  const passcodes = dbCache?.passcodes.filter((item) => item.reservationId === reservation.id) || [];
  return {
    ...reservation,
    passcode: passcodes[0]
      ? {
          status: passcodes[0].status,
          startsAt: passcodes[0].startsAt,
          endsAt: passcodes[0].endsAt,
          code: passcodes[0].status === "active" ? passcodes[0].code : null
        }
      : null,
    passcodes: passcodes.map((passcode) => ({
      roomId: passcode.roomId,
      status: passcode.status,
      startsAt: passcode.startsAt,
      endsAt: passcode.endsAt,
      code: passcode.status === "active" ? passcode.code : null
    }))
  };
}

export function normalizeDb(db) {
  const normalized = { ...structuredClone(defaultDb), ...db };
  for (const key of ["rooms", "organizations", "loginTokens", "sessions", "emailMessages", "reservations", "passcodes", "switchbotEvents", "auditLogs"]) {
    if (!Array.isArray(normalized[key])) normalized[key] = [];
  }

  const existingRoomIds = new Set(normalized.rooms.map((room) => room.id));
  for (const room of defaultDb.rooms) {
    if (!existingRoomIds.has(room.id)) normalized.rooms.push(room);
  }

  normalized.rooms.forEach((room, index) => {
    room.sortOrder = Number.isFinite(Number(room.sortOrder)) ? Number(room.sortOrder) : index;
    room.archivedAt ||= null;
    room.lockDeviceId ||= null;
  });

  for (const organization of normalized.organizations) {
    organization.facilityAccessRole = FACILITY_ACCESS_ROLES.has(organization.facilityAccessRole)
      ? organization.facilityAccessRole
      : "general";
  }

  for (const reservation of normalized.reservations) {
    if (!Array.isArray(reservation.roomIds)) {
      reservation.roomIds = reservation.roomId ? [reservation.roomId] : [];
    }
    if (!reservation.roomId && reservation.roomIds[0]) {
      reservation.roomId = reservation.roomIds[0];
    }
    reservation.rejectionComment ||= "";
    reservation.cancelComment ||= "";
    reservation.cancelWarning ||= "";
    reservation.approvedAt ||= null;
    reservation.rejectedAt ||= null;
    reservation.cancelledAt ||= null;
  }

  for (const passcode of normalized.passcodes) {
    if (
      passcode.status === "pending"
      && passcode.raw?.statusCode === 100
      && !passcode.commandId
      && !passcode.keyId
    ) {
      passcode.status = "active";
      passcode.warning = "SwitchBot accepted createKey, but passcode id was not returned. Deletion may require the SwitchBot app.";
    }
  }

  for (const reservation of normalized.reservations) {
    if (reservation.status !== "issuing") continue;
    const passcodes = normalized.passcodes.filter((passcode) => passcode.reservationId === reservation.id);
    if (passcodes.length > 0 && passcodes.every((passcode) => passcode.status === "active")) {
      reservation.status = "approved";
    }
  }

  return normalized;
}

export function facilityAccessRole(organization) {
  return FACILITY_ACCESS_ROLES.has(organization?.facilityAccessRole)
    ? organization.facilityAccessRole
    : "general";
}

export function canOrganizationReserveRoom(organization, room) {
  if (!room || !COMMITTEE_ONLY_ROOM_IDS.has(room.id)) return true;
  return facilityAccessRole(organization) === "committee";
}

export async function loadDb() {
  if (dbCache) return dbCache;
  try {
    const raw = await readFile(dbPath, "utf8");
    dbCache = normalizeDb(JSON.parse(raw));
  } catch {
    dbCache = structuredClone(defaultDb);
    await saveDb();
  }
  return dbCache;
}

export async function saveDb() {
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, `${JSON.stringify(dbCache, null, 2)}\n`);
}

export async function getDb() {
  return loadDb();
}

export async function addAuditLog(action, details = {}) {
  const db = await getDb();
  db.auditLogs.unshift({
    id: makeId("log"),
    action,
    details,
    createdAt: new Date().toISOString()
  });
  await saveDb();
}

export function hasRoomConflict(db, roomIds, startsAt, endsAt, ignoreReservationId = null) {
  const targetRoomIds = Array.isArray(roomIds) ? roomIds : [roomIds];
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  return db.reservations.some((reservation) => {
    if (reservation.id === ignoreReservationId) return false;
    const reservationRoomIds = Array.isArray(reservation.roomIds)
      ? reservation.roomIds
      : [reservation.roomId];
    if (!targetRoomIds.some((roomId) => reservationRoomIds.includes(roomId))) return false;
    if (["rejected", "cancelled"].includes(reservation.status)) return false;
    const existingStart = new Date(reservation.startsAt).getTime();
    const existingEnd = new Date(reservation.endsAt).getTime();
    return start < existingEnd && end > existingStart;
  });
}

export function isAnnualOrganizationResetDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "numeric",
    day: "numeric",
    timeZone: "Asia/Tokyo"
  }).formatToParts(date);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return month === 3 && day === 31;
}

export function resetOrganizationsForAcademicYear(db, resetAt = new Date()) {
  const organizationIds = new Set((db.organizations || []).map((organization) => organization.id));
  const resetAtIso = new Date(resetAt).toISOString();
  const organizationCount = organizationIds.size;

  db.organizations = [];
  db.sessions = (db.sessions || []).filter((session) => !organizationIds.has(session.organizationId));
  db.loginTokens = (db.loginTokens || []).filter((token) => !organizationIds.has(token.organizationId));
  for (const reservation of db.reservations || []) {
    if (!organizationIds.has(reservation.organizationId)) continue;
    reservation.organizationDeletedAt ||= resetAtIso;
    reservation.updatedAt = resetAtIso;
  }

  return { organizationCount, resetAt: resetAtIso };
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$120000$${salt}$${hash}`;
}

export function verifyPassword(password, passwordHash) {
  if (!passwordHash) return false;
  const [algorithm, iterationsRaw, salt, expected] = passwordHash.split("$");
  if (algorithm !== "pbkdf2_sha256" || !iterationsRaw || !salt || !expected) return false;
  const iterations = Number(iterationsRaw);
  const actual = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}
