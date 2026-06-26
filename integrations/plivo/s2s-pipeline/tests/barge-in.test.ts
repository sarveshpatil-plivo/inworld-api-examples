/**
 * Behavioral test — barge-in (HARNESS.md layer L3).
 *
 * Proves the runtime behavior that static checks (L2) can't: while the agent is
 * speaking, a caller interruption must (a) clear Plivo playback, (b) cancel the
 * in-flight Inworld response, and (c) actually STOP the outgoing audio.
 *
 * Fully offline & deterministic — no API key, no phone call, no real Inworld:
 *   - a fake Inworld WS server speaks the minimal Realtime protocol and streams
 *     audio deltas to simulate a long reply, then we inject `speech_started`.
 *   - a fake Plivo WS pair lets us feed the agent and record what it sends back.
 *
 * Run:  npm test   (from s2s-pipeline/)   or   npx tsx tests/barge-in.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";

// Point the agent at our fake before importing it — these are read at module load.
process.env.INWORLD_API_KEY = "test-key";
process.env.SYSTEM_PROMPT = "You are a test agent.";

/** One 160-byte μ-law frame's worth of audio, base64 — Inworld sends these. */
const DELTA_B64 = Buffer.alloc(320, 0x7f).toString("base64");

/** Poll `cond` every 10ms until true or timeout; throws with `label` on timeout. */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Minimal fake Inworld Realtime server. Returns control handles for the test. */
function startFakeInworld() {
  const wss = new WebSocketServer({ port: 0 });
  const state = { receivedCancel: false, conn: null as WebSocket | null };
  let deltaTimer: ReturnType<typeof setInterval> | null = null;

  const stopDeltas = () => { if (deltaTimer) { clearInterval(deltaTimer); deltaTimer = null; } };
  const startDeltas = () => {
    stopDeltas();
    deltaTimer = setInterval(() => {
      state.conn?.send(JSON.stringify({ type: "response.output_audio.delta", delta: DELTA_B64 }));
    }, 10);
  };

  wss.on("connection", (ws) => {
    state.conn = ws;
    ws.send(JSON.stringify({ type: "session.created" }));
    ws.on("message", (data: Buffer) => {
      let msg: { type?: string };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.type) {
        case "session.update":
          ws.send(JSON.stringify({ type: "session.updated" }));
          break;
        case "response.create":
          startDeltas(); // simulate a long spoken reply
          break;
        case "response.cancel":
          state.receivedCancel = true;
          stopDeltas();
          break;
      }
    });
  });

  return {
    port: () => (wss.address() as AddressInfo).port,
    /** Inject a caller interruption. A real semantic-VAD also stops generating. */
    sendSpeechStarted: () => {
      stopDeltas();
      state.conn?.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    },
    receivedCancel: () => state.receivedCancel,
    close: () => { stopDeltas(); wss.close(); },
  };
}

test("barge-in: caller interruption clears playback and cancels the reply", async () => {
  const inworld = startFakeInworld();
  process.env.INWORLD_REALTIME_URL = `ws://127.0.0.1:${inworld.port()}`;

  // Fake Plivo WS pair: agent gets the server side, the test holds the client side.
  const plivoServer = new WebSocketServer({ port: 0 });
  const agentSocketP = new Promise<WebSocket>((res) => plivoServer.on("connection", res));
  const plivoClient = new WebSocket(`ws://127.0.0.1:${(plivoServer.address() as AddressInfo).port}`);

  let playAudioCount = 0;
  let clearAudioCount = 0;
  plivoClient.on("message", (data: Buffer) => {
    let msg: { event?: string };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.event === "playAudio") playAudioCount++;
    else if (msg.event === "clearAudio") clearAudioCount++;
  });

  await new Promise((r) => plivoClient.on("open", r));
  const agentSocket = await agentSocketP;

  // Import after env is set, then drive the agent directly (no server.ts needed).
  const { runAgent } = await import("../inbound/agent.ts");
  const done = runAgent({ plivoWs: agentSocket, callId: "test-call", streamId: "test-stream" });

  try {
    // 1. Agent should be speaking — paced playAudio frames flowing to Plivo.
    await waitFor(() => playAudioCount >= 3, "agent to start speaking (playAudio frames)");
    assert.ok(playAudioCount >= 3, "agent emitted playAudio while speaking");

    // 2. Caller barges in mid-reply.
    inworld.sendSpeechStarted();

    // 3. Contract: clears Plivo playback + cancels the Inworld response.
    await waitFor(() => clearAudioCount >= 1, "clearAudio sent to Plivo");
    await waitFor(() => inworld.receivedCancel(), "response.cancel sent to Inworld");

    // 4. Playback must actually STOP (the real bug: it kept playing after barge-in).
    const countAtClear = playAudioCount;
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      playAudioCount - countAtClear <= 1, // tolerate at most one in-flight frame
      `playAudio must stop after barge-in (got ${playAudioCount - countAtClear} more frames)`,
    );
  } finally {
    // Always release sockets/servers so a failing assertion reports — never hangs.
    plivoClient.close();
    inworld.close();
    plivoServer.close();
    await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
  }
});
