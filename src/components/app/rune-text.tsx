import type { CSSProperties } from "react";

// Elder Futhark, as in the dictation overlay.
const RUNES = "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ";
const SETTLE_MS = 220; // how long a word stays runes before its first letter shows
const STAGGER_MS = 30; // between letters, so a word resolves left to right
const WORD_STAGGER_MS = 60; // between words
const FLICKER_MS = 120; // one rune-flicker step (keep in sync with .rune-ch::before)

/** The rune shown over a letter: fixed per position, so server and client agree. */
export function runeFor(char: string, index: number): string {
  const runes = Array.from(RUNES);
  return runes[(char.codePointAt(0)! * 7 + index * 13) % runes.length];
}

/**
 * The space between rune letters. Chrome leaves a bare space next to the
 * letters' rune layer out of the accessible name ("Yourbudget."); a space in
 * its own pre-wrap span stays in, and still wraps like any other.
 */
export function RuneSpace() {
  return <span className="whitespace-pre-wrap"> </span>;
}

/**
 * Text that arrives as runes and settles into letters, once, when it mounts.
 * The animation is CSS only (.rune-ch in globals.css): this lays out one span
 * per letter with its rune and timing. The letters are the only copy of the
 * text (the rune is CSS content with empty alt text), so screen readers, copy
 * and crawlers read it once. Change `key` to play it again.
 */
export function RuneText({ text, delay = 0 }: { text: string; delay?: number }) {
  let position = 0;
  const words = text.split(" ");
  return (
    <>
      {words.map((word, w) => {
        const wordStart = delay + SETTLE_MS + WORD_STAGGER_MS * w;
        const letters = Array.from(word).map((char, c) => {
          const at = wordStart + STAGGER_MS * c;
          const skew = (position * 37) % FLICKER_MS;
          const style = {
            "--rune-at": `${at}ms`,
            "--rune-skew": `-${skew}ms`,
            "--rune-ticks": Math.ceil((at + skew) / FLICKER_MS) + 1
          } as CSSProperties;
          const rune = runeFor(char, position);
          position += 1;
          return (
            <span key={c} className="rune-ch" data-rune={rune} style={style}>
              {char}
            </span>
          );
        });
        return (
          <span key={w}>
            {w > 0 ? <RuneSpace /> : null}
            <span className="whitespace-nowrap">{letters}</span>
          </span>
        );
      })}
    </>
  );
}
