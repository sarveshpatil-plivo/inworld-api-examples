/**
 * Plivo XML webhook: returns XML with <Stream> to open a bidirectional
 * media stream back to our WebSocket server.
 */
import { Router } from "express";
import { config } from "../config.js";

export const xmlRouter = Router();

xmlRouter.post("/voice", (_req, res) => {
  const wsUrl = new URL("/media-stream", config.serverUrl);
  wsUrl.protocol = wsUrl.protocol === "http:" ? "ws:" : "wss:";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    ${wsUrl.toString()}
  </Stream>
</Response>`;

  res.type("application/xml").send(xml);
});

xmlRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", pipeline: "cascaded" });
});
