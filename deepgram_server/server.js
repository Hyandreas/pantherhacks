import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(dirname, ".env"));

const PORT = Number(process.env.PORT ?? 8788);
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL ?? "nova-3";
const LIBRETRANSLATE_URL = process.env.LIBRETRANSLATE_URL;
const PROFILES_PATH = path.join(dirname, "speaker_profiles.json");
const MAX_FRAME_BYTES = 1024 * 1024;
const SOCKET_OPEN = 1;

const server = http.createServer((req, res) => {
  setCorsHeaders(req, res);

  void handleHttpRequest(req, res);
});

async function handleHttpRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    writeJson(res, 200, {
      ok: true,
      provider: "deepgram",
      model: DEEPGRAM_MODEL,
      hasApiKey: Boolean(DEEPGRAM_API_KEY),
      profileEditingRequiresAuth: false,
    });
    return;
  }

  if (req.method === "POST" && req.url === "/auth/login") {
    await readJsonBody(req);
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/translate") {
    const payload = await readJsonBody(req);
    const result = await translateText(payload);
    writeJson(res, result.ok ? 200 : 502, result);
    return;
  }

  if (req.method === "GET" && req.url === "/speaker-profiles") {
    writeJson(res, 200, { profiles: readSpeakerProfiles() });
    return;
  }

  if (req.method === "PUT" && req.url === "/speaker-profiles") {
    const payload = await readJsonBody(req);
    const profiles = Array.isArray(payload?.profiles)
      ? sanitizeProfiles(payload.profiles)
      : [];
    writeSpeakerProfiles(profiles);
    writeJson(res, 200, { profiles });
    return;
  }

  if (req.method === "POST" && req.url === "/speaker-profiles") {
    const payload = await readJsonBody(req);
    const profile = sanitizeProfile(payload);

    if (!profile) {
      writeJson(res, 400, { error: "Invalid speaker profile." });
      return;
    }

    const profiles = readSpeakerProfiles();
    const existingIndex = profiles.findIndex((item) => isSameProfile(item, profile));
    const nextProfiles =
      existingIndex >= 0
        ? profiles.map((item, index) => (index === existingIndex ? profile : item))
        : [...profiles, profile];

    writeSpeakerProfiles(nextProfiles);
    writeJson(res, 200, { profile, profiles: nextProfiles });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
}

server.on("upgrade", (req, socket) => {
  if (!req.url?.startsWith("/captions")) {
    socket.destroy();
    return;
  }

  if (!DEEPGRAM_API_KEY) {
    socket.write("HTTP/1.1 500 Missing Deepgram API key\r\n\r\n");
    socket.destroy();
    return;
  }

  const websocketKey = req.headers["sec-websocket-key"];
  if (typeof websocketKey !== "string") {
    socket.destroy();
    return;
  }

  acceptWebSocket(socket, websocketKey);
  proxyCaptions(socket);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use on 127.0.0.1.`);
    console.error("Stop the old process or set a different PORT in deepgram_server/.env.");
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Lumen Deepgram proxy listening on ws://127.0.0.1:${PORT}/captions`);
  console.log(`Model: ${DEEPGRAM_MODEL}`);
});

function proxyCaptions(clientSocket) {
  const upstream = connectToDeepgram({
    onOpen: () => {
      console.log("Connected to Deepgram.");
      upstreamOpen = true;
      while (pendingAudio.length > 0) {
        upstream.send(pendingAudio.shift());
      }
    },
    onMessage: (text) => {
      writeFrame(clientSocket, 1, Buffer.from(text));
    },
    onError: (message) => {
      console.error(message);
      sendClientError(clientSocket, message);
    },
    onClose: (code, reason) => {
      if (!closed && !upstreamOpen) {
        sendClientError(
          clientSocket,
          `Deepgram rejected the connection${reason ? `: ${reason}` : "."}`,
        );
      }
      if (code !== 1000) {
        console.error(`Deepgram closed with code ${code}${reason ? `: ${reason}` : ""}`);
      }
      closeAll();
    },
  });
  const pendingAudio = [];
  let clientBuffer = Buffer.alloc(0);
  let upstreamOpen = false;
  let closed = false;

  const keepAlive = setInterval(() => {
    if (upstream.readyState === SOCKET_OPEN) {
      upstream.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, 8000);

  clientSocket.on("data", (chunk) => {
    clientBuffer = Buffer.concat([clientBuffer, chunk]);

    while (clientBuffer.length > 0) {
      const frame = readFrame(clientBuffer);
      if (!frame) break;

      clientBuffer = clientBuffer.subarray(frame.frameBytes);

      if (frame.opcode === 8) {
        closeAll();
        return;
      }

      if (frame.opcode === 9) {
        writeFrame(clientSocket, 10, frame.payload);
        continue;
      }

      if (frame.opcode !== 1 && frame.opcode !== 2) {
        continue;
      }

      if (frame.payload.length > MAX_FRAME_BYTES) {
        sendClientError(clientSocket, "Audio frame is too large.");
        closeAll();
        return;
      }

      if (upstreamOpen && upstream.readyState === SOCKET_OPEN) {
        upstream.send(frame.payload);
      } else {
        pendingAudio.push(frame.payload);
      }
    }
  });

  clientSocket.on("error", closeAll);
  clientSocket.on("close", closeAll);

  function closeAll() {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);

    if (upstream.readyState === SOCKET_OPEN) {
      upstream.send(JSON.stringify({ type: "CloseStream" }));
    }
    upstream.close();

    if (!clientSocket.destroyed) {
      writeFrame(clientSocket, 8, Buffer.alloc(0));
      clientSocket.end();
    }
  }
}

function buildDeepgramUrl() {
  const url = new URL("wss://api.deepgram.com/v1/listen");
  url.searchParams.set("model", DEEPGRAM_MODEL);
  url.searchParams.set("language", "en-US");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("diarize", "true");
  url.searchParams.set("vad_events", "true");
  url.searchParams.set("utterance_end_ms", "1000");
  return url.toString();
}

function connectToDeepgram({ onOpen, onMessage, onError, onClose }) {
  const deepgramUrl = new URL(buildDeepgramUrl());
  const websocketKey = crypto.randomBytes(16).toString("base64");
  const socket = tls.connect(443, deepgramUrl.hostname, {
    servername: deepgramUrl.hostname,
  });

  let readyState = 0;
  let handshakeComplete = false;
  let buffer = Buffer.alloc(0);

  socket.on("secureConnect", () => {
    const request = [
      `GET ${deepgramUrl.pathname}${deepgramUrl.search} HTTP/1.1`,
      `Host: ${deepgramUrl.hostname}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${websocketKey}`,
      "Sec-WebSocket-Version: 13",
      `Authorization: Token ${DEEPGRAM_API_KEY}`,
      "\r\n",
    ].join("\r\n");

    socket.write(request);
  });

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (!handshakeComplete) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerText = buffer.subarray(0, headerEnd).toString("utf8");
      const body = buffer.subarray(headerEnd + 4);
      const statusLine = headerText.split("\r\n")[0] ?? "";

      if (!statusLine.includes(" 101 ")) {
        readyState = 3;
        onError(`Deepgram handshake failed: ${statusLine}`);
        if (body.length > 0) {
          onError(body.toString("utf8"));
        }
        socket.end();
        return;
      }

      handshakeComplete = true;
      readyState = SOCKET_OPEN;
      buffer = body;
      onOpen();
    }

    while (buffer.length > 0) {
      const frame = readFrame(buffer);
      if (!frame) break;

      buffer = buffer.subarray(frame.frameBytes);

      if (frame.opcode === 1) {
        onMessage(frame.payload.toString("utf8"));
      } else if (frame.opcode === 8) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : "";
        readyState = 3;
        onClose(code, reason);
        return;
      } else if (frame.opcode === 9) {
        writeMaskedFrame(socket, 10, frame.payload);
      }
    }
  });

  socket.on("error", (error) => {
    readyState = 3;
    onError(`Deepgram socket error: ${error.message}`);
  });

  socket.on("close", () => {
    if (readyState !== 3) {
      readyState = 3;
      onClose(1006, "");
    }
  });

  return {
    get readyState() {
      return readyState;
    },
    send(payload) {
      if (readyState !== SOCKET_OPEN) return;
      const opcode = typeof payload === "string" ? 1 : 2;
      const data = Buffer.isBuffer(payload)
        ? payload
        : payload instanceof Uint8Array
          ? Buffer.from(payload)
          : Buffer.from(String(payload));
      writeMaskedFrame(socket, opcode, data);
    },
    close() {
      if (readyState === 3) return;
      readyState = 2;
      writeMaskedFrame(socket, 8, Buffer.alloc(0));
      socket.end();
    },
  };
}

function acceptWebSocket(socket, websocketKey) {
  const accept = crypto
    .createHash("sha1")
    .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n"));
}

function readFrame(buffer) {
  if (buffer.length < 2) return null;

  const opcode = buffer[0] & 0x0f;
  const masked = Boolean(buffer[1] & 0x80);
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame is too large.");
    }
    length = Number(bigLength);
    offset += 8;
  }

  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    frameBytes: offset + length,
  };
}

function writeFrame(socket, opcode, payload) {
  if (socket.destroyed) return;

  const header = [];
  header.push(0x80 | opcode);

  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65536) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    const length = BigInt(payload.length);
    header.push(127);
    for (let shift = 56; shift >= 0; shift -= 8) {
      header.push(Number((length >> BigInt(shift)) & 0xffn));
    }
  }

  socket.write(Buffer.concat([Buffer.from(header), payload]));
}

function writeMaskedFrame(socket, opcode, payload) {
  if (socket.destroyed) return;

  const header = [];
  header.push(0x80 | opcode);

  if (payload.length < 126) {
    header.push(0x80 | payload.length);
  } else if (payload.length < 65536) {
    header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    const length = BigInt(payload.length);
    header.push(0x80 | 127);
    for (let shift = 56; shift >= 0; shift -= 8) {
      header.push(Number((length >> BigInt(shift)) & 0xffn));
    }
  }

  const mask = crypto.randomBytes(4);
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] ^= mask[index % 4];
  }

  socket.write(Buffer.concat([Buffer.from(header), mask, maskedPayload]));
}

function sendClientError(socket, message) {
  writeFrame(socket, 1, Buffer.from(JSON.stringify({ type: "Error", error: message })));
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (isLocalOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else if (!origin || origin === "file://") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function isLocalOrigin(origin) {
  if (typeof origin !== "string") return false;

  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function writeJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function translateText(payload) {
  const text = String(payload?.text ?? "").trim().slice(0, 1000);
  const source = normalizeLanguageCode(payload?.source);
  const target = normalizeLanguageCode(payload?.target);

  if (!text) {
    return { ok: true, translatedText: "", provider: "none" };
  }

  if (!source || !target) {
    return { ok: false, error: "Unsupported translation language." };
  }

  if (source === target) {
    return { ok: true, translatedText: text, provider: "none" };
  }

  if (LIBRETRANSLATE_URL) {
    const libreResult = await translateWithLibreTranslate(text, source, target);
    if (libreResult.ok) return libreResult;
  }

  return translateWithMyMemory(text, source, target);
}

async function translateWithLibreTranslate(text, source, target) {
  try {
    const response = await fetch(`${LIBRETRANSLATE_URL.replace(/\/$/, "")}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: text,
        source,
        target,
        format: "text",
      }),
    });
    const payload = await response.json();
    const translatedText = String(payload?.translatedText ?? "").trim();
    if (!response.ok || !translatedText) {
      return { ok: false, error: "LibreTranslate failed." };
    }
    return { ok: true, translatedText, provider: "libretranslate" };
  } catch {
    return { ok: false, error: "LibreTranslate unavailable." };
  }
}

async function translateWithMyMemory(text, source, target) {
  try {
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", text);
    url.searchParams.set("langpair", `${source}|${target}`);

    const response = await fetch(url, {
      headers: { "User-Agent": "Lumen local caption proxy" },
    });
    const payload = await response.json();
    const translatedText = String(payload?.responseData?.translatedText ?? "").trim();
    if (!response.ok || !translatedText) {
      return { ok: false, error: "Translation provider failed." };
    }
    return { ok: true, translatedText, provider: "mymemory" };
  } catch {
    return { ok: false, error: "Translation provider unavailable." };
  }
}

function normalizeLanguageCode(value) {
  const supported = new Set(["en", "es", "fr", "zh-CN", "hi", "ar", "pt", "ko", "ja"]);
  const code = String(value ?? "").trim();
  return supported.has(code) ? code : "";
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve(null);
      }
    });

    req.on("error", () => resolve(null));
  });
}

function readSpeakerProfiles() {
  if (!fs.existsSync(PROFILES_PATH)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
    return Array.isArray(parsed) ? sanitizeProfiles(parsed) : [];
  } catch {
    return [];
  }
}

function writeSpeakerProfiles(profiles) {
  fs.writeFileSync(PROFILES_PATH, `${JSON.stringify(sanitizeProfiles(profiles), null, 2)}\n`);
}

function sanitizeProfiles(profiles) {
  return dedupeProfiles(profiles
    .map(sanitizeProfile)
    .filter(Boolean)
  ).slice(0, 100);
}

function dedupeProfiles(profiles) {
  return profiles.reduce((acc, profile) => {
    const existingIndex = acc.findIndex((item) => isSameProfile(item, profile));
    if (existingIndex === -1) {
      acc.push(profile);
      return acc;
    }

    acc[existingIndex] = mergeProfiles(acc[existingIndex], profile);
    return acc;
  }, []);
}

function isSameProfile(left, right) {
  return (
    left.id === right.id ||
    overlappingSources(left.sources, right.sources)
  );
}

function mergeProfiles(existing, next) {
  return {
    ...existing,
    ...next,
    label: next.label || existing.label,
    relation: next.relation || existing.relation,
    description: next.description || existing.description,
    source: next.source || existing.source,
    sources: mergeSources(existing.sources, next.sources),
    signature: next.signature?.length ? next.signature : existing.signature,
    createdAt: existing.createdAt || next.createdAt,
    lastSeenAt: next.lastSeenAt || existing.lastSeenAt,
  };
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;

  const label = String(profile.label ?? "").trim().slice(0, 32);
  const id = String(profile.id ?? "").trim().slice(0, 64);
  if (!id || !label) return null;

  const now = new Date().toISOString();
  return {
    id,
    label,
    relation: String(profile.relation ?? "").trim().slice(0, 48),
    description: String(profile.description ?? "").trim().slice(0, 240),
    source: sanitizeSource(profile.source),
    sources: sanitizeSources(profile.sources, profile.source),
    signature: sanitizeSignature(profile.signature),
    createdAt: String(profile.createdAt ?? now).slice(0, 40),
    lastSeenAt: String(profile.lastSeenAt ?? now).slice(0, 40),
  };
}

function sanitizeSource(source) {
  return String(source ?? "").trim().slice(0, 64);
}

function sanitizeSources(sources, legacySource) {
  const values = Array.isArray(sources) ? sources : [];
  const sanitized = [...values, legacySource]
    .map(sanitizeSource)
    .filter(Boolean);
  return Array.from(new Set(sanitized)).slice(0, 12);
}

function mergeSources(left = [], right = []) {
  return Array.from(new Set([...left, ...right].filter(Boolean))).slice(0, 12);
}

function overlappingSources(left = [], right = []) {
  return left.some((source) => right.includes(source));
}

function sanitizeSignature(signature) {
  if (!Array.isArray(signature)) return [];

  return signature
    .slice(0, 12)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => Number(value.toFixed(6)));
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
