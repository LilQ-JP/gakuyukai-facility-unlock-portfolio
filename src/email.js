import net from "node:net";
import tls from "node:tls";
import { config } from "./config.js";
import { addAuditLog, getDb, makeId, saveDb } from "./store.js";

function formatDateTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo"
  }).format(new Date(value));
}

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function normalizeLineBreaks(value) {
  return String(value).replace(/\r?\n/g, "\r\n");
}

async function readSmtpResponse(socket) {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1);
      if (last && /^\d{3} /.test(last)) {
        socket.off("data", onData);
        const code = Number(last.slice(0, 3));
        resolve({ code, text: buffer });
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function smtpCommand(socket, command, expectedCodes) {
  socket.write(`${command}\r\n`);
  const response = await readSmtpResponse(socket);
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`SMTP command failed (${command}): ${response.text}`);
  }
  return response;
}

function connectSmtp() {
  return new Promise((resolve, reject) => {
    const options = { host: config.smtpHost, port: config.smtpPort, servername: config.smtpHost };
    const socket = config.smtpSecure ? tls.connect(options) : net.connect(options);
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
    socket.setTimeout(15000, () => {
      socket.destroy(new Error("SMTP connection timed out."));
    });
  });
}

async function sendSmtpMail({ to, subject, text }) {
  if (!config.smtpHost || !config.mailFrom) {
    throw new Error("SMTP is not configured. Set SMTP_HOST and MAIL_FROM.");
  }

  let socket = await connectSmtp();
  await readSmtpResponse(socket);
  await smtpCommand(socket, `EHLO ${config.smtpHost}`, [250]);

  if (!config.smtpSecure && config.smtpPort !== 25) {
    await smtpCommand(socket, "STARTTLS", [220]);
    socket = tls.connect({ socket, servername: config.smtpHost });
    await smtpCommand(socket, `EHLO ${config.smtpHost}`, [250]);
  }

  if (config.smtpUser && config.smtpPass) {
    await smtpCommand(socket, "AUTH LOGIN", [334]);
    await smtpCommand(socket, Buffer.from(config.smtpUser).toString("base64"), [334]);
    await smtpCommand(socket, Buffer.from(config.smtpPass).toString("base64"), [235]);
  }

  await smtpCommand(socket, `MAIL FROM:<${config.mailFrom}>`, [250]);
  await smtpCommand(socket, `RCPT TO:<${to}>`, [250, 251]);
  await smtpCommand(socket, "DATA", [354]);

  const message = [
    `From: ${config.mailFrom}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeLineBreaks(text)
  ].join("\r\n");
  socket.write(`${message}\r\n.\r\n`);
  const dataResponse = await readSmtpResponse(socket);
  if (![250].includes(dataResponse.code)) {
    throw new Error(`SMTP DATA failed: ${dataResponse.text}`);
  }
  await smtpCommand(socket, "QUIT", [221]);
}

export async function sendEmail({ to, subject, text }) {
  const db = await getDb();
  const message = {
    id: makeId("mail"),
    to,
    subject,
    text,
    mode: config.emailMode === "smtp" ? "smtp" : "log",
    status: "pending",
    createdAt: new Date().toISOString()
  };
  db.emailMessages.unshift(message);
  await saveDb();

  if (config.emailMode === "smtp") {
    try {
      await sendSmtpMail({ to, subject, text });
      message.status = "sent";
      message.sentAt = new Date().toISOString();
      await saveDb();
      await addAuditLog("email.sent", { to, subject });
      return message;
    } catch (error) {
      message.status = "failed";
      message.error = error.message;
      await saveDb();
      await addAuditLog("email.failed", { to, subject, message: error.message });
      throw error;
    }
  }

  message.status = "logged";
  await saveDb();
  await addAuditLog("email.logged", { to, subject });

  console.log("\n--- Mock email ---");
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(text);
  console.log("--- End mock email ---\n");

  return message;
}

export function makeLoginEmail({ organization, token }) {
  const url = `${config.baseUrl}/auth/verify?token=${encodeURIComponent(token)}`;
  return {
    to: organization.email,
    subject: "学友会施設予約システム ログインリンク",
    text: `${organization.name} 様\n\n以下のリンクからマイページにログインできます。\n${url}\n\nこのリンクは30分で期限切れになります。心当たりがない場合は破棄してください。`
  };
}

export function makeReservationCreatedEmail({ organization, reservation, rooms }) {
  return {
    to: organization.email,
    subject: "施設予約申請を受け付けました",
    text: `${organization.name} 様\n\n施設予約申請を受け付けました。現在は学友会の承認待ちです。\n\n施設: ${rooms.map((room) => room.name).join("、")}\n開始: ${formatDateTime(reservation.startsAt)}\n終了: ${formatDateTime(reservation.endsAt)}\n状態: 承認待ち\n\nマイページで状態を確認できます。`
  };
}

export function makeReservationStatusEmail({ organization, reservation, rooms, passcodes = [], statusLabel, comment = "" }) {
  const commentBlock = comment ? `\n\n学友会コメント:\n${comment}` : "";
  const activePasscodes = statusLabel === "承認済み"
    ? passcodes.filter((passcode) => passcode.status === "active" && passcode.code)
    : [];
  const passcodeBlock = activePasscodes.length > 0
    ? `\n\n一時暗証番号:\n${activePasscodes
        .map((passcode) => {
          const room = rooms.find((item) => item.id === passcode.roomId);
          return `${room?.name || passcode.roomId}: ${passcode.code}`;
        })
        .join("\n")}\n有効期間: ${formatDateTime(activePasscodes[0].startsAt)} から ${formatDateTime(activePasscodes[0].endsAt)}\n\n暗証番号は利用団体の関係者以外へ共有しないでください。`
    : "";
  const confirmationGuide = statusLabel === "承認済み" && activePasscodes.length === 0
    ? "\n\n暗証番号の発行状況はマイページで確認してください。"
    : "";
  return {
    to: organization.email,
    subject: `施設予約が${statusLabel}になりました`,
    text: `${organization.name} 様\n\n申請した施設予約の状態が「${statusLabel}」になりました。\n\n施設: ${rooms.map((room) => room.name).join("、")}\n開始: ${formatDateTime(reservation.startsAt)}\n終了: ${formatDateTime(reservation.endsAt)}${passcodeBlock}${commentBlock}${confirmationGuide}\n\n予約内容と最新状態はマイページでも確認できます。`
  };
}
