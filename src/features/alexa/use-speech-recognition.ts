/**
 * src/features/alexa/use-speech-recognition.ts
 *
 * Push-to-talk wrapper around the browser SpeechRecognition
 * (`en-IN`, interim results). The page owns hold-vs-tap and barge-in; this
 * hook owns recognizer lifecycle: start/stop, interim + final transcripts,
 * and the denied/unsupported states the page renders.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSpeechRecognitionCtor, type SpeechRecognitionLike } from "./speech-types";

export type RecognitionStatus = "idle" | "listening" | "denied" | "unsupported";

export function useSpeechRecognition(options?: { lang?: string }) {
  const lang = options?.lang ?? "en-IN";
  const recognizerRef = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef("");
  const [status, setStatus] = useState<RecognitionStatus>("idle");
  const [interim, setInterim] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");

  const supported =
    typeof window !== "undefined" && getSpeechRecognitionCtor() !== null;

  const teardown = useCallback(() => {
    const recognizer = recognizerRef.current;
    recognizerRef.current = null;
    if (recognizer) {
      recognizer.onresult = null;
      recognizer.onerror = null;
      recognizer.onend = null;
      try {
        recognizer.abort();
      } catch {
        // Already stopped; nothing to do.
      }
    }
  }, []);

  useEffect(() => teardown, [teardown]);

  // Surface "unsupported" on first paint (not only after the first mic tap).
  // Effect, not an initializer, so server and client render the same HTML.
  useEffect(() => {
    if (!getSpeechRecognitionCtor()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only support probe is safe
      setStatus("unsupported");
    }
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setStatus("unsupported");
      return false;
    }
    // A previous session that ended in denial stays denied until start succeeds.
    teardown();
    finalRef.current = "";
    setFinalTranscript("");
    setInterim("");
    const recognizer = new Ctor();
    recognizer.lang = lang;
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 1;
    recognizer.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alternative = result[0];
        if (!alternative) continue;
        if (result.isFinal) {
          finalRef.current = `${finalRef.current} ${alternative.transcript}`.trim();
        } else {
          interimText += alternative.transcript;
        }
      }
      setFinalTranscript(finalRef.current);
      setInterim(interimText);
    };
    recognizer.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setStatus("denied");
      }
    };
    recognizer.onend = () => {
      // A denial ends the session: stay on "denied" so the page can show the
      // allow-mic guidance. Any other end returns to idle.
      setStatus((current) => (current === "listening" ? "idle" : current));
    };
    recognizerRef.current = recognizer;
    try {
      recognizer.start();
    } catch {
      return false;
    }
    setStatus("listening");
    return true;
  }, [lang, teardown]);

  const stop = useCallback(() => {
    const recognizer = recognizerRef.current;
    recognizerRef.current = null;
    if (recognizer) {
      // Detach handlers first: a programmatic stop must land on idle, and a
      // denial (if any) was already committed to state by onerror.
      recognizer.onresult = null;
      recognizer.onerror = null;
      recognizer.onend = null;
      try {
        recognizer.stop();
      } catch {
        // Already stopped; nothing to do.
      }
    }
    setStatus((current) => (current === "denied" ? "denied" : "idle"));
    setInterim("");
    return finalRef.current;
  }, []);

  return { status, supported, interim, finalTranscript, start, stop };
}
