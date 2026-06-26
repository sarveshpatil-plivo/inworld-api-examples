/**
 * Behavioral test — end_call tool (HARNESS.md layer L3).
 *
 * Proves the function-calling round-trip: when Inworld emits a
 * `response.function_call_arguments.done` for `end_call`, the agent must
 *   (a) return the result via `conversation.item.create` (function_call_output),
 *   (b) let the farewell play, then
 *   (c) hang up the call (invoke the server-provided `hangup` handler).
 *
 * Fully offline & deterministic — a fake Inworld WS server scripts the tool
 * call; a fake Plivo WS pair feeds the agent. No key, no phone.
 *
 * Run:  npm test   (from s2s-pipeline/)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";

process.env.INWORLD_API_KEY = "test-key";
process.env.SYSTEM_PROMPT = "You are a test agent.";

const DELTA_B64 = Buffer.alloc(320, 0x7f).toString("base64");
const CALL_ID = "call-1";

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Fake Inworld that scripts an end_call tool invocation on the first response. */
function startFakeInworld() {
  const wss = new WebSocketServer({ port: 0 });
  const state = { functionOutputCallId: null as string | null, conn: null as WebSocket | null };
  let responseCount = 0;

  const streamAudio = (ws: WebSocket, n: number) => {
    for (let i = 0; i < n; i++) ws.send(JSON.stringify({ type: "response.output_audio.delta", delta: DELTA_B64 }));
  };

  wss.on("connection", (ws) => {
    state.conn = ws;
    ws.send(JSON.stringify({ type: "session.created" }));
    ws.on("message", (data: Buffer) => {
      let msg: { type?: string; item?: { type?: string; call_id?: string } };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.type) {
        case "session.update":
          ws.send(JSON.stringify({ type: "session.updated" }));
          break;
        case "response.create":
          responseCount++;
          if (responseCount === 1) {
            // First turn: speak a little, then call end_call.
            streamAudio(ws, 3);
            ws.send(JSON.stringify({
              type: "response.function_call_arguments.done",
              call_id: CALL_ID, name: "end_call", arguments: JSON.stringify({ reason: "caller said goodbye" }),
            }));
            ws.send(JSON.stringify({ type: "response.done" }));
          } else {
            // Farewell turn (triggered after the agent returns the tool result).
            streamAudio(ws, 3);
            ws.send(JSON.stringify({ type: "response.done" }));
          }
          break;
        case "conversation.item.create":
          if (msg.item?.type === "function_call_output") state.functionOutputCallId = msg.item.call_id ?? null;
          break;
      }
    });
  });

  return {
    port: () => (wss.address() as AddressInfo).port,
    functionOutputCallId: () => state.functionOutputCallId,
    close: () => wss.close(),
  };
}

test("end_call: returns the tool result and hangs up after the farewell", async () => {
  const inworld = startFakeInworld();
  process.env.INWORLD_REALTIME_URL = `ws://127.0.0.1:${inworld.port()}`;

  const plivoServer = new WebSocketServer({ port: 0 });
  const agentSocketP = new Promise<WebSocket>((res) => plivoServer.on("connection", res));
  const plivoClient = new WebSocket(`ws://127.0.0.1:${(plivoServer.address() as AddressInfo).port}`);
  await new Promise((r) => plivoClient.on("open", r));
  const agentSocket = await agentSocketP;

  let hangupCalled = false;
  const { runAgent } = await import("../inbound/agent.ts");
  const done = runAgent({
    plivoWs: agentSocket, callId: CALL_ID, streamId: "test-stream",
    hangup: () => { hangupCalled = true; },
  });

  try {
    // The agent must return the tool result with the matching call_id.
    await waitFor(() => inworld.functionOutputCallId() === CALL_ID, "function_call_output returned to Inworld");

    // ...and then hang up once the farewell has played (~600ms grace in the agent).
    await waitFor(() => hangupCalled, "hangup invoked after farewell", 4000);
    assert.ok(hangupCalled, "agent hung up the call");
  } finally {
    plivoClient.close();
    inworld.close();
    plivoServer.close();
    await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
  }
});
