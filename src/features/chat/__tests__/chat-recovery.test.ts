import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { ChatRecovery, isRecoverableChatError, prepareChatRecovery } from "../chat-recovery";

afterEach(() => vi.useRealTimers());

describe("bounded chat recovery", () => {
  it("retries once, resets for a new request, and can cancel a pending attempt", () => {
    vi.useFakeTimers();
    const recovery = new ChatRecovery();
    const resume = vi.fn();
    expect(recovery.schedule(new Error("Upstream provider error"), resume)).toBe(true);
    vi.runAllTimers();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(recovery.schedule(new Error("503 unavailable"), resume)).toBe(false);
    recovery.reset();
    expect(recovery.schedule(new Error("502 bad gateway"), resume)).toBe(true);
    recovery.cancel();
    vi.runAllTimers();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(recovery.schedule(new Error("503 unavailable"), resume)).toBe(false);
  });

  it.each([new DOMException("Stopped", "AbortError"), new Error("401 upstream error"), new Error("Invalid API key"), new Error("Invalid tool input")])("does not recover terminal errors or cancellations: %s", (error) => {
    expect(isRecoverableChatError(error)).toBe(false);
  });

  it("preserves completed tools and text while removing unfinished calls", () => {
    const messages = [{ id: "assistant", role: "assistant", parts: [
      { type: "text", text: "Checking the build" },
      { type: "tool-validate_build", toolCallId: "done", state: "output-available", input: {}, output: { valid: true } },
      { type: "tool-present_build", toolCallId: "partial", state: "input-streaming", input: {} },
      { type: "dynamic-tool", toolName: "consult", toolCallId: "pending", state: "input-available", input: {} }
    ] }] as UIMessage[];
    const clean = prepareChatRecovery(messages);
    expect(clean[0].parts).toEqual(messages[0].parts.slice(0, 2));
    expect(messages[0].parts).toHaveLength(4);
  });
});

// Exercise the installed SDK: continuation must send retained results, not regenerate the turn.
it("continues an interrupted SDK stream without replaying completed tool execution", async () => {
  const { Chat } = await import("@ai-sdk/react");
  const { convertToModelMessages } = await import("ai");
  vi.useFakeTimers();
  const requests: UIMessage[][] = [];
  const chat = new Chat<UIMessage>({
    transport: {
      reconnectToStream: async () => null,
      sendMessages: async ({ messages }) => {
        requests.push(structuredClone(messages));
        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "start", messageId: "answer" });
            if (requests.length === 1) {
              controller.enqueue({ type: "tool-input-available", toolCallId: "checked", toolName: "validate_build", input: { parts: {} } });
              controller.enqueue({ type: "tool-output-available", toolCallId: "checked", output: { valid: true } });
              controller.enqueue({ type: "tool-input-start", toolCallId: "unfinished", toolName: "present_build" });
              controller.enqueue({ type: "tool-input-delta", toolCallId: "unfinished", inputTextDelta: '{"builds":' });
              controller.enqueue({ type: "error", errorText: "502 upstream provider error" });
            } else {
              controller.enqueue({ type: "text-start", id: "text" });
              controller.enqueue({ type: "text-delta", id: "text", delta: "Recovered" });
              controller.enqueue({ type: "text-end", id: "text" });
              controller.enqueue({ type: "finish", finishReason: "stop" });
            }
            controller.close();
          }
        });
      }
    }
  });
  await chat.sendMessage({ text: "Build a PC" });
  expect(chat.status).toBe("error");
  const recovery = new ChatRecovery();
  recovery.schedule(chat.error, () => {
    chat.messages = prepareChatRecovery(chat.messages);
    void chat.sendMessage();
  });
  await vi.runAllTimersAsync();
  expect(requests).toHaveLength(2);
  expect(requests[1].filter((message) => message.role === "user")).toHaveLength(1);
  const retained = requests[1].flatMap((message) => message.parts);
  expect(retained).toContainEqual(expect.objectContaining({ toolCallId: "checked", state: "output-available" }));
  expect(retained).not.toContainEqual(expect.objectContaining({ toolCallId: "unfinished" }));
  await expect(convertToModelMessages(requests[1])).resolves.toBeDefined();
  expect(chat.status).toBe("ready");
});
