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
 * V of geese crosses on wide screens.
 *
 * Performance: capped at 24 fps, device pixel ratio capped at 2, nothing is
 * drawn while the tab is hidden or the canvas is off screen, and the loop
 * stops when the component unmounts. Reduced motion draws one still frame.
 * Mount it only where nobody is reading a conversation.
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

export function AsciiSky({ className, density = 1 }: { className?: string; density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    const birds: Bird[] = [];
    let flock: Flock | null = null;
    let nextFlockAt = rand(6, 14);
    let color = "#e8eee8";
    let font = "monospace";
    let visible = true;
    let raf = 0;
    let last = 0;
    let elapsed = 0;
    const pointer = { x: -1e4, y: -1e4 };

    const readTheme = () => {
      const styles = getComputedStyle(document.documentElement);
      color = styles.getPropertyValue("--text").trim() || color;
      font = styles.getPropertyValue("--font-mono-jb").trim() || "monospace";
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(14, Math.max(4, ((width * height) / 90_000) * density)));
      while (birds.length < count) birds.push(makeBird(width, height, true));
      birds.length = count;
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let layer = 0; layer < LAYERS.length; layer++) {
        const { size, alpha, bob } = LAYERS[layer];
        ctx.font = `500 ${size}px ${font}`;
        ctx.globalAlpha = alpha;
        for (const bird of birds) {
          if (bird.layer !== layer) continue;
          const glyph = bird.flapping > 0 ? FLAP[Math.floor((t + bird.phase) / bird.flapEvery) % FLAP.length] : GLIDE;
          const y = bird.y + Math.sin((t + bird.phase) * 1.3) * bob + bird.lift;
          ctx.fillText(glyph, bird.x, y);
        }
      }
      if (flock) {
        ctx.font = `500 ${LAYERS[1].size}px ${font}`;
        ctx.globalAlpha = LAYERS[1].alpha;
        for (const member of flock.members) {
          const glyph = FLAP[Math.floor((t + member.phase) / 0.16) % FLAP.length];
          ctx.fillText(glyph, flock.x + member.dx, flock.y + member.dy + Math.sin((t + member.phase) * 1.1) * 3);
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
        if (bird.x < -60 || bird.x > width + 60) birds[i] = makeBird(width, height, false);
      }
      if (flock) {
        flock.x += flock.dir * LAYERS[1].speed * 1.6 * dt;
        if (flock.x < -260 || flock.x > width + 260) {
          flock = null;
          nextFlockAt = elapsed + rand(25, 45);
        }
      } else if (width >= 900 && elapsed > nextFlockAt) {
        flock = makeFlock(width, height);
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
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    intersection.observe(canvas);
    // Theme switches rewrite the tokens on <html>; pick up the new text color.
    const themeObserver = new MutationObserver(() => {
      readTheme();
      if (reduceMotion) draw(0);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
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
