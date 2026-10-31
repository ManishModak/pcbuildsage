"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/components/ui/cn";

/*
 * ASCII birds drifting behind a page, drawn as text on one 2D canvas.
 *
 * A cheap cousin of the ASCII sea on manishmodak.github.io: no WebGL, no
 * models, just a few dozen fillText calls a frame. Birds cross at three
 * depths (far ones smaller, fainter and slower), flap in bursts and glide in
 * between, bob on the air, and lift away from the pointer. Now and then a
 * V of geese crosses on wide screens. Faint clouds drift behind them, and on
 * a dark theme the sky is a night sky: stars twinkle above.
 *
 * Everything lives within the first screen of the canvas, so a tall section
 * doesn't spread the sky below the fold.
 *
 * Performance: capped at 24 fps, device pixel ratio capped at 2, nothing is
 * drawn while the tab is hidden or the canvas is off screen, and the loop
 * stops when the component unmounts. Reduced motion draws one still frame.
 * Mount it only where nobody is reading a conversation.
 *
 * Text stays clear: birds fade out as they reach any element marked
 * `data-sky-quiet` beside the canvas, so they seem to pass behind it.
 */

const FRAME_MS = 1000 / 24;
const FLAP = ["\\v/", "-v-", "/v\\", "-v-"]; // wings up, level, down, level
const GLIDE = "-v-";
const LAYERS = [
  { size: 11, alpha: 0.26, speed: 14, bob: 4 },
  { size: 13, alpha: 0.36, speed: 24, bob: 7 },
  { size: 16, alpha: 0.48, speed: 38, bob: 10 }
] as const;
const POINTER_RADIUS = 110;
const QUIET_FADE_PX = 28; // birds fade over this distance before marked text
// A cloud fades as a whole, over CLOUD.fade px, before it reaches marked text.
const CLOUDS = [
  ["   .--.", " .(    ).", "(___.__)__)"],
  ["        .-~~-.", "  .-~~-(      )-.", " (                )", "  `-.__.--.__.--'"],
  ["   _.-~~-._    _.-~-._", ".-'        `--'       `-.", "`-.___________________.-'"]
];
const CLOUD = { size: 13, alpha: 0.2, fade: 60 } as const;
const STAR_GLYPHS = [".", ".", ".", "·", "·", "+", "*"];

type Box = { left: number; top: number; right: number; bottom: number };

type Bird = {
  layer: number;
  x: number;
  y: number;
  lift: number; // pushed up or down by the pointer, eases back to 0
  dir: 1 | -1;
  phase: number; // seconds offset for bobbing and flapping
  flapEvery: number; // seconds per flap frame
  flapping: number; // seconds left in the current flap burst
  gliding: number; // seconds left gliding once the burst ends
};

type Flock = { x: number; y: number; dir: 1 | -1; members: Array<{ dx: number; dy: number; phase: number }> };

type Cloud = { shape: string[]; cols: number; x: number; y: number; dir: 1 | -1; speed: number };

type Star = { x: number; y: number; glyph: string; alpha: number; phase: number; rate: number };

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeBird(width: number, height: number, anywhere: boolean): Bird {
  const layer = Math.random() < 0.45 ? 0 : Math.random() < 0.65 ? 1 : 2;
  const dir: 1 | -1 = Math.random() < 0.7 ? -1 : 1;
  return {
    layer,
    x: anywhere ? rand(0, width) : dir === 1 ? -40 : width + 40,
    y: rand(height * 0.06, height * 0.7),
    lift: 0,
    dir,
    phase: rand(0, 10),
    flapEvery: rand(0.11, 0.18),
    flapping: rand(0, 1.2),
    gliding: rand(1.2, 2.6)
  };
}

function makeFlock(width: number, height: number): Flock {
  const dir: 1 | -1 = Math.random() < 0.5 ? -1 : 1;
  const members: Flock["members"] = [{ dx: 0, dy: 0, phase: 0 }];
  for (let i = 1; i <= 3; i++) {
    members.push({ dx: -dir * i * 26, dy: -i * 12, phase: i * 0.13 });
    members.push({ dx: -dir * i * 26, dy: i * 12, phase: i * 0.13 + 0.07 });
  }
  return { x: dir === 1 ? -120 : width + 120, y: rand(height * 0.12, height * 0.45), dir, members };
}

// Clouds ride the same wind as most birds: mostly right to left, slowly.
// `charWidth` is the cloud font's letter width, to start one fully off screen;
// `others` are the clouds already up, so two never share a shape.
function makeCloud(width: number, height: number, anywhere: boolean, charWidth: number, others: Cloud[]): Cloud {
  const free = CLOUDS.filter((shape) => !others.some((cloud) => cloud.shape === shape));
  const shape = free[Math.floor(Math.random() * free.length)] ?? CLOUDS[0];
  const dir: 1 | -1 = Math.random() < 0.8 ? -1 : 1;
  const cols = Math.max(...shape.map((line) => line.length));
  const span = cols * charWidth;
  return {
    shape,
    cols,
    x: anywhere ? rand(0, width - span) : dir === 1 ? -span - 20 : width + 20,
    y: rand(height * 0.06, height * 0.85),
    dir,
    speed: rand(4, 8)
  };
}

function makeStars(width: number, height: number, density: number): Star[] {
  const count = Math.round(Math.min(48, Math.max(12, (width * height) / 26_000)) * density);
  return Array.from({ length: count }, () => ({
    x: rand(0, width),
    y: rand(0, height * 0.75),
    glyph: STAR_GLYPHS[Math.floor(Math.random() * STAR_GLYPHS.length)],
    alpha: rand(0.18, 0.5),
    phase: rand(0, 10),
    rate: rand(0.4, 1.4)
  }));
}

export function AsciiSky({ className, density = 1 }: { className?: string; density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let sky = 0; // the first screen of the canvas, where everything flies
    const birds: Bird[] = [];
    let flock: Flock | null = null;
    let nextFlockAt = rand(6, 14);
    const clouds: Cloud[] = [];
    let cloudCharWidth = 8;
    let stars: Star[] = [];
    let night = false;
    let color = "#e8eee8";
    let font = "monospace";
    let visible = true;
    let raf = 0;
    let last = 0;
    let elapsed = 0;
    const pointer = { x: -1e4, y: -1e4 };
    let quiet: Box[] = [];

    // Boxes of the text the birds pass behind, in canvas coordinates.
    const measureQuiet = () => {
      const origin = canvas.getBoundingClientRect();
      const marked = canvas.parentElement?.querySelectorAll<HTMLElement>("[data-sky-quiet]") ?? [];
      quiet = Array.from(marked, (element) => {
        const box = element.getBoundingClientRect();
        return {
          left: box.left - origin.left,
          top: box.top - origin.top,
          right: box.right - origin.left,
          bottom: box.bottom - origin.top
        };
      });
    };

    // 1 in open sky, easing to 0 over `fade` px as a point (a bird) or an
    // area (a cloud) reaches marked text.
    const openness = (left: number, top: number, right = left, bottom = top, fade: number = QUIET_FADE_PX) => {
      let factor = 1;
      for (const box of quiet) {
        const dx = Math.max(box.left - right, 0, left - box.right);
        const dy = Math.max(box.top - bottom, 0, top - box.bottom);
        factor = Math.min(factor, Math.hypot(dx, dy) / fade);
      }
      return factor;
    };

    const readTheme = () => {
      const styles = getComputedStyle(document.documentElement);
      color = styles.getPropertyValue("--text").trim() || color;
      font = styles.getPropertyValue("--font-mono-jb").trim() || "monospace";
      night = document.documentElement.dataset.themeMode !== "light";
      ctx.font = `400 ${CLOUD.size}px ${font}`;
      cloudCharWidth = ctx.measureText("M").width;
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      sky = Math.min(height, window.innerHeight || height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(14, Math.max(4, ((width * sky) / 90_000) * density)));
      while (birds.length < count) birds.push(makeBird(width, sky, true));
      birds.length = count;
      const cloudCount = width >= 700 ? 2 : 1;
      while (clouds.length < cloudCount) clouds.push(makeCloud(width, sky, true, cloudCharWidth, clouds));
      clouds.length = cloudCount;
      stars = makeStars(width, sky, density);
      measureQuiet();
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (night) {
        ctx.font = `400 11px ${font}`;
        for (const star of stars) {
          const open = openness(star.x, star.y);
          if (open <= 0) continue;
          ctx.globalAlpha = star.alpha * (0.6 + 0.4 * Math.sin((t + star.phase) * star.rate)) * open;
          ctx.fillText(star.glyph, star.x, star.y);
        }
      }
      ctx.font = `400 ${CLOUD.size}px ${font}`;
      ctx.textAlign = "left";
      const lineHeight = CLOUD.size * 1.15;
      for (const cloud of clouds) {
        const right = cloud.x + cloud.cols * cloudCharWidth;
        const bottom = cloud.y + cloud.shape.length * lineHeight;
        const open = openness(cloud.x, cloud.y - lineHeight, right, bottom, CLOUD.fade);
        if (open <= 0) continue;
        ctx.globalAlpha = CLOUD.alpha * open;
        cloud.shape.forEach((line, row) => ctx.fillText(line, cloud.x, cloud.y + row * lineHeight));
      }
      ctx.textAlign = "center";
      for (let layer = 0; layer < LAYERS.length; layer++) {
        const { size, alpha, bob } = LAYERS[layer];
        ctx.font = `500 ${size}px ${font}`;
        for (const bird of birds) {
          if (bird.layer !== layer) continue;
          const y = bird.y + Math.sin((t + bird.phase) * 1.3) * bob + bird.lift;
          const open = openness(bird.x, y);
          if (open <= 0) continue;
          ctx.globalAlpha = alpha * open;
          const glyph = bird.flapping > 0 ? FLAP[Math.floor((t + bird.phase) / bird.flapEvery) % FLAP.length] : GLIDE;
          ctx.fillText(glyph, bird.x, y);
        }
      }
      if (flock) {
        ctx.font = `500 ${LAYERS[1].size}px ${font}`;
        for (const member of flock.members) {
          const x = flock.x + member.dx;
          const y = flock.y + member.dy + Math.sin((t + member.phase) * 1.1) * 3;
          const open = openness(x, y);
          if (open <= 0) continue;
          ctx.globalAlpha = LAYERS[1].alpha * open;
          ctx.fillText(FLAP[Math.floor((t + member.phase) / 0.16) % FLAP.length], x, y);
        }
      }
      ctx.globalAlpha = 1;
    };

    const step = (dt: number) => {
      for (let i = 0; i < birds.length; i++) {
        const bird = birds[i];
        const { speed } = LAYERS[bird.layer];
        bird.x += bird.dir * speed * dt * (bird.flapping > 0 ? 1.15 : 1);
        if (bird.flapping > 0) {
          bird.flapping -= dt;
        } else if ((bird.gliding -= dt) <= 0) {
          bird.flapping = rand(0.6, 1.6);
          bird.gliding = rand(1.2, 2.6);
        }
        // Lift away from a nearby pointer, then drift back to the flight line.
        const dx = bird.x - pointer.x;
        const dy = bird.y + bird.lift - pointer.y;
        const dist = Math.hypot(dx, dy);
        if (dist < POINTER_RADIUS) {
          bird.lift += (dy <= 0 ? -1 : 1) * (1 - dist / POINTER_RADIUS) * 90 * dt;
          bird.flapping = Math.max(bird.flapping, 0.5);
        }
        bird.lift *= 1 - Math.min(1, dt * 0.6);
        if (bird.x < -60 || bird.x > width + 60) birds[i] = makeBird(width, sky, false);
      }
      for (let i = 0; i < clouds.length; i++) {
        const cloud = clouds[i];
        cloud.x += cloud.dir * cloud.speed * dt;
        const span = cloud.cols * cloudCharWidth;
        if (cloud.x + span < -20 || cloud.x > width + 20) {
          clouds[i] = makeCloud(width, sky, false, cloudCharWidth, clouds.filter((other) => other !== cloud));
        }
      }
      if (flock) {
        flock.x += flock.dir * LAYERS[1].speed * 1.6 * dt;
        if (flock.x < -260 || flock.x > width + 260) {
          flock = null;
          nextFlockAt = elapsed + rand(25, 45);
        }
      } else if (width >= 900 && elapsed > nextFlockAt) {
        flock = makeFlock(width, sky);
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) {
        last = now;
        return;
      }
      if (now - last < FRAME_MS) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      elapsed += dt;
      step(dt);
      draw(elapsed);
    };

    readTheme();
    resize();

    if (reduceMotion) {
      draw(0);
    } else {
      raf = requestAnimationFrame((now) => {
        last = now;
        raf = requestAnimationFrame(loop);
      });
    }

    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (reduceMotion) draw(0);
    });
    resizeObserver.observe(canvas);
    // Web fonts change text heights after first paint.
    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (disposed) return;
      readTheme();
      measureQuiet();
      if (reduceMotion) draw(0);
    });
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    intersection.observe(canvas);
    // Theme switches rewrite the tokens on <html>; pick up the new text color.
    const themeObserver = new MutationObserver(() => {
      readTheme();
      if (reduceMotion) draw(0);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-theme-mode", "style"] });
    const onPointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
    };
    const onLeave = () => {
      pointer.x = -1e4;
      pointer.y = -1e4;
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("pointerleave", onLeave);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersection.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("pointerleave", onLeave);
    };
  }, [density]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    />
  );
}
