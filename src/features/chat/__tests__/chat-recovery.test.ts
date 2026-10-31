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

it("detects silent unfinished turns without retrying cancellation, errors, answers, or presented builds", async () => {
  const { isIncompleteChatFinish } = await import("../chat-recovery");
  const flags = { isAbort: false, isError: false };
  const empty: UIMessage = { id: "a", role: "assistant", parts: [{ type: "reasoning", text: "Checking" }] };
  expect(isIncompleteChatFinish(empty, flags)).toBe(true);
  expect(isIncompleteChatFinish(empty, { ...flags, isAbort: true })).toBe(false);
  expect(isIncompleteChatFinish(empty, { ...flags, isError: true })).toBe(false);
  expect(isIncompleteChatFinish({ ...empty, parts: [{ type: "text", text: "Here is your answer" }] }, flags)).toBe(false);
  expect(isIncompleteChatFinish({ ...empty, parts: [{ type: "tool-present_build", toolCallId: "b", state: "output-available", input: {}, output: { presented: true, builds: [{}] } }] }, flags)).toBe(false);
  expect(isIncompleteChatFinish({ ...empty, parts: [{ type: "tool-present_build", toolCallId: "b", state: "input-streaming", input: {} }] }, flags)).toBe(true);
});

it("shares one recovery budget across silent endings and provider errors", () => {
  vi.useFakeTimers();
  const recovery = new ChatRecovery();
  const resume = vi.fn();
  expect(recovery.scheduleIncomplete(resume)).toBe(true);
  vi.runAllTimers();
  expect(recovery.schedule(new Error("502 upstream"), resume)).toBe(false);
  expect(recovery.scheduleIncomplete(resume)).toBe(false);
  recovery.reset();
  expect(recovery.schedule(new Error("502 upstream"), resume)).toBe(true);
  vi.runAllTimers();
  expect(recovery.scheduleIncomplete(resume)).toBe(false);
  recovery.reset();
  recovery.cancel();
  expect(recovery.scheduleIncomplete(resume)).toBe(false);
});

it("continues a clean SDK finish with only tool work once, then reports incompletion", async () => {
  const { Chat } = await import("@ai-sdk/react");
  const { isIncompleteChatFinish } = await import("../chat-recovery");
  vi.useFakeTimers();
  const recovery = new ChatRecovery();
  let requests = 0;
  let incompleteNotice = false;
  const chat = new Chat<UIMessage>({
    onFinish: ({ message, isAbort, isError }) => {
      if (isIncompleteChatFinish(message, { isAbort, isError })) {
        incompleteNotice = !recovery.scheduleIncomplete(() => {
          chat.messages = prepareChatRecovery(chat.messages);
          void chat.sendMessage();
        });
      }
    },
    transport: {
      reconnectToStream: async () => null,
      sendMessages: async () => {
        requests++;
        return new ReadableStream({ start(controller) {
          controller.enqueue({ type: "start", messageId: "silent" });
          if (requests === 1) {
            controller.enqueue({ type: "tool-input-available", toolCallId: "search", toolName: "search_products", input: {} });
            controller.enqueue({ type: "tool-output-available", toolCallId: "search", output: { results: [] } });
          }
          controller.enqueue({ type: "finish", finishReason: "stop" });
          controller.close();
        } });
      }
    }
  });
  await chat.sendMessage({ text: "Build a PC" });
  expect(incompleteNotice).toBe(false);
  await vi.runAllTimersAsync();
  expect(requests).toBe(2);
  expect(incompleteNotice).toBe(true);
  expect(chat.status).toBe("ready");
});

describe("context limit error recovery", () => {
  it("identifies context window and token limit overflow errors", async () => {
    const { isContextLimitError, isRecoverableChatError } = await import("../chat-recovery");
    const ctxErr1 = new Error("This model's maximum context length is 8192 tokens");
    const ctxErr2 = new Error("context_length_exceeded");
    const ctxErr3 = new Error("prompt is too long");
    const networkErr = new Error("502 bad gateway");

    expect(isContextLimitError(ctxErr1)).toBe(true);
    expect(isContextLimitError(ctxErr2)).toBe(true);
    expect(isContextLimitError(ctxErr3)).toBe(true);
    expect(isContextLimitError(networkErr)).toBe(false);

    // Context limit errors MUST NOT qualify for plain isRecoverableChatError replay
    expect(isRecoverableChatError(ctxErr1)).toBe(false);
    expect(isRecoverableChatError(ctxErr2)).toBe(false);
  });

  it("bounds context recovery to one attempt and respects cancellation", async () => {
    const recovery = new ChatRecovery();
    const ctxErr = new Error("context limit exceeded");
    let attempts = 0;

    const scheduled = recovery.scheduleContextRecovery(ctxErr, async (signal) => {
      attempts++;
      if (signal.aborted) return;
    });
    expect(scheduled).toBe(true);

    // Second consecutive context error cannot recover again (bounded)
    const secondSchedule = recovery.scheduleContextRecovery(ctxErr, () => {
      attempts++;
    });
    expect(secondSchedule).toBe(false);
    expect(recovery.canRecover()).toBe(false);
    expect(attempts).toBe(1);

    // Cancellation aborts in-flight recovery signal
    recovery.reset();
    let aborted = false;
    recovery.scheduleContextRecovery(ctxErr, async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
    });
    recovery.cancel();
    expect(aborted).toBe(true);
  });
});

