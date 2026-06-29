/**
 * Standalone server for inbound calls (Plivo telephony + Plivo provisioning).
 *
 * Telephony only — the STT→LLM→TTS pipeline lives in agent.ts.
 *   - On startup, ensure the Plivo Application + number→app mapping exist.
 *   - POST/GET /answer  → Plivo XML opening a bidirectional μ-law media stream
 *   - WS   /ws          → hands the stream to the agent once it starts
 *   - POST /hangup      → logs call teardown
 *   - POST /fallback    → graceful failure message
 *   - GET  /            → health check
 */
import "dotenv/config";
import { createServer } from "node:http";
import express from "express";
import plivo from "plivo";
import { WebSocketServer, WebSocket } from "ws";
import { runAgent } from "./agent.js";
import { normalizePhoneNumber } from "../utils.js";

const SERVER_PORT = parseInt(process.env.SERVER_PORT || "3000", 10);
const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID || "";
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN || "";
const PLIVO_PHONE_NUMBER = process.env.PLIVO_PHONE_NUMBER || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const APP_NAME = "Inworld_STT_LLM_TTS_Voice_Agent";

// Shared Plivo client (provisioning + hanging up calls when the agent asks).
const plivoClient =
  PLIVO_AUTH_ID && PLIVO_AUTH_TOKEN ? new plivo.Client(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN) : null;

async function configurePlivoWebhooks(): Promise<boolean> {
  const missing = [
    ["PLIVO_AUTH_ID", PLIVO_AUTH_ID],
    ["PLIVO_AUTH_TOKEN", PLIVO_AUTH_TOKEN],
    ["PLIVO_PHONE_NUMBER", PLIVO_PHONE_NUMBER],
    ["PUBLIC_URL", PUBLIC_URL],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.warn(`[provision] Skipping Plivo auto-config. Missing: ${missing.join(", ")}`);
    return false;
  }

  try {
    const client = plivoClient!;
    const answerUrl = `${PUBLIC_URL}/answer`;
    const hangupUrl = `${PUBLIC_URL}/hangup`;
    const fallbackUrl = `${PUBLIC_URL}/fallback`;

    const apps: any = await client.applications.list();
    const existing = (apps?.objects ?? apps ?? []).find((a: any) => a.appName === APP_NAME || a.app_name === APP_NAME);

    let appId: string;
    if (existing) {
      appId = existing.appId ?? existing.app_id;
      await client.applications.update(appId, {
        answerUrl, answerMethod: "POST", hangupUrl, hangupMethod: "POST", fallbackAnswerUrl: fallbackUrl,
      } as any);
      console.log(`[provision] Updated Plivo application: ${APP_NAME}`);
    } else {
      const created: any = await client.applications.create(APP_NAME, {
        answerUrl, answerMethod: "POST", hangupUrl, hangupMethod: "POST", fallbackAnswerUrl: fallbackUrl,
      } as any);
      appId = created.appId ?? created.app_id;
      console.log(`[provision] Created Plivo application: ${APP_NAME}`);
    }

    const number = normalizePhoneNumber(PLIVO_PHONE_NUMBER);
    if (!number) {
      console.error(`[provision] Invalid phone number: ${PLIVO_PHONE_NUMBER}`);
      return false;
    }
    await client.numbers.update(number, { appId });
    console.log(`[provision] Mapped +${number} → ${APP_NAME}`);
    console.log(`[provision]   Answer URL: ${answerUrl}`);
    return true;
  } catch (err) {
    console.error(`[provision] Failed to configure Plivo: ${(err as Error).message}`);
    return false;
  }
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Reflects whether startup auto-provisioning mapped the number (see GET /).
let provisioned = false;

app.get("/", (_req, res) => {
  const phone = normalizePhoneNumber(PLIVO_PHONE_NUMBER);
  res.status(provisioned ? 200 : 503).json({
    status: provisioned ? "ok" : "setup-incomplete",
    service: "inworld-stt-llm-tts-inbound",
    phone_number: phone ? `+${phone}` : "not configured",
  });
});

function answerHandler(req: express.Request, res: express.Response) {
  const callId = String(req.body?.CallUUID ?? req.query.CallUUID ?? "");
  const from = String(req.body?.From ?? req.query.From ?? "");
  const to = String(req.body?.To ?? req.query.To ?? "");
  console.log(`[answer] Incoming call: CallUUID=${callId}, From=${from}, To=${to}`);

  const body = Buffer.from(JSON.stringify({ call_uuid: callId, from, to })).toString("base64");
  const wsUrl = `${PUBLIC_URL.replace(/^http/, "ws").replace(/\/$/, "")}/ws?body=${body}`;

  const response: any = new (plivo as any).Response();
  response.addStream(wsUrl, { bidirectional: true, keepCallAlive: true, contentType: "audio/x-mulaw;rate=8000" });
  res.type("application/xml").send(response.toXML());
}
app.get("/answer", answerHandler);
app.post("/answer", answerHandler);

app.post("/hangup", (req, res) => {
  console.log(`[hangup] Call ended: CallUUID=${req.body?.CallUUID}, Duration=${req.body?.Duration}s, Cause=${req.body?.HangupCause}`);
  res.type("text/plain").send("OK");
});

app.all("/fallback", (_req, res) => {
  console.warn("[fallback] Fallback webhook triggered");
  const response: any = new (plivo as any).Response();
  response.addSpeak("We're sorry, but we're experiencing technical difficulties. Please try again later.");
  response.addHangup({});
  res.type("application/xml").send(response.toXML());
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req) => {
  if (!req.url?.startsWith("/ws")) { ws.close(); return; }

  let meta: { call_uuid?: string; from?: string; to?: string } = {};
  try {
    const bodyParam = new URL(req.url, "http://x").searchParams.get("body");
    if (bodyParam) meta = JSON.parse(Buffer.from(bodyParam, "base64").toString());
  } catch { /* noop */ }

  ws.once("message", (data: Buffer) => {
    let start: { event?: string; start?: { callId?: string; streamId?: string } };
    try { start = JSON.parse(data.toString()); } catch { ws.close(); return; }
    if (start.event !== "start") { console.error(`[ws] expected start, got ${start.event}`); ws.close(); return; }

    const resolvedCallId = start.start?.callId || meta.call_uuid;
    const callId = resolvedCallId || "unknown";
    const streamId = start.start?.streamId || "";
    console.log(`[ws] Plivo stream started: callId=${callId}, streamId=${streamId}`);

    runAgent({
      plivoWs: ws,
      callId,
      streamId,
      fromNumber: meta.from,
      // Hang up the live call via the Plivo REST API when the agent calls
      // end_call. Only wire it when we have a real CallUUID to act on.
      hangup: plivoClient && resolvedCallId
        ? () => plivoClient.calls.hangup(resolvedCallId).then(() => undefined)
        : undefined,
    })
      .catch((err) => {
        console.error(`[ws] agent error:`, err);
        try { ws.close(); } catch { /* noop */ }
      });
  });
});

async function main() {
  // Fail fast on the most common setup mistake rather than booting "healthy"
  // and failing every call later with a swallowed 401.
  if (!process.env.INWORLD_API_KEY) {
    console.error("[server] INWORLD_API_KEY is not set — the agent cannot authenticate to Inworld (needs STT+Router+TTS scopes). Set it in .env.");
    process.exit(1);
  }

  if (PLIVO_PHONE_NUMBER && PUBLIC_URL) {
    console.log("[server] Configuring Plivo webhooks...");
    provisioned = await configurePlivoWebhooks();
    if (provisioned) {
      console.log(`[server] Ready! Call +${normalizePhoneNumber(PLIVO_PHONE_NUMBER)} to test`);
    } else {
      console.warn("[server] ⚠ SETUP INCOMPLETE — Plivo auto-config failed; inbound calls will not route until the number is mapped. Configure it manually or fix the error above.");
    }
  } else {
    console.log("[server] Set PUBLIC_URL + PLIVO_PHONE_NUMBER to enable Plivo auto-config.");
  }

  server.listen(SERVER_PORT, () => {
    console.log(`[server] Listening on port ${SERVER_PORT}`);
    console.log(`[server] Answer webhook: ${PUBLIC_URL || `http://localhost:${SERVER_PORT}`}/answer`);
  });
}

process.on("SIGINT", () => { server.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });

main();
