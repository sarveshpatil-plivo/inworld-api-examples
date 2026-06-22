/**
 * Inworld Router/LLM client.
 *
 * Sends conversation messages to Inworld's Router API and streams responses.
 * Docs: https://docs.inworld.ai/router/overview
 */
import { config } from "../config.js";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Streams a chat completion from Inworld Router API.
 * Yields text chunks as they arrive.
 */
export async function* streamChatCompletion(
  messages: Message[],
  signal?: AbortSignal
): AsyncGenerator<string> {
  const response = await fetch("https://api.inworld.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${config.inworldApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Inworld Router API error ${response.status}: ${body}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // ignore parse errors
        }
      }
    }
  }
}

/**
 * Non-streaming chat completion (simpler but higher latency).
 */
export async function chatCompletion(messages: Message[]): Promise<string> {
  const response = await fetch("https://api.inworld.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Basic ${config.inworldApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Inworld Router API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}
