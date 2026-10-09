/**
 * src/features/alexa/use-speech-synthesis.ts
 *
 * Spoken replies via the browser speechSynthesis (no paid services). Picks an
 * `en-IN` voice when one is installed, falls back to any English voice.
 * The page calls `stop()` for barge-in (mic pressed, message sent, new
 * conversation); `speak` is a no-op while muted.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const byLang = (prefix: string) => voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix));
  return byLang("en-in") ?? byLang("en") ?? voices[0] ?? null;
}

export function useSpeechSynthesis() {
  const [muted, setMuted] = useState(false);
  const [supported] = useState(
    () => typeof window !== "undefined" && "speechSynthesis" in window
  );
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    if (!supported) return;
    const refresh = () => {
      voiceRef.current = pickVoice(window.speechSynthesis.getVoices());
    };
    refresh();
    window.speechSynthesis.onvoiceschanged = refresh;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [supported]);

  // Never leave speech running across unmount / conversation reset.
  useEffect(() => {
    if (!supported) return;
    return () => window.speechSynthesis.cancel();
  }, [supported]);

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
  }, [supported]);

  const speak = useCallback(
    (text: string) => {
      if (!supported || mutedRef.current) return;
      const clean = text.trim();
      if (clean.length === 0) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(clean);
      utterance.lang = "en-IN";
      if (voiceRef.current) utterance.voice = voiceRef.current;
      window.speechSynthesis.speak(utterance);
    },
    [supported]
  );

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      if (!current && supported) window.speechSynthesis.cancel();
      return !current;
    });
  }, [supported]);

  return { supported, muted, toggleMuted, speak, stop };
}
