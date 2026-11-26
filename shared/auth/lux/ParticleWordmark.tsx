/* Lucian UX/UI Prompt #378 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#378 */
"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/shared/lib/utils";
import "./ParticleWordmark.css";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  h: number;
  on: boolean;
}

const WORD = "GroupProof";
const MARGIN = 3;

function getDotSize(width: number): number {
  return width < 480 ? 2.6 : 3.2;
}

function buildTargets(
  word: string,
  width: number,
  height: number,
): { pts: Array<[number, number]>; step: number } {
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext("2d");
  if (!ctx) return { pts: [], step: width < 480 ? 3 : 4 };

  const maxW = width * 0.88;
  const maxH = height * 0.66;
  let fontSize = Math.max(24, Math.min(116, Math.floor(maxH)));

  const applyFont = (size: number) => {
    ctx.font = `900 ${size}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", system-ui, sans-serif`;
  };
  applyFont(fontSize);

  const initialWidth = ctx.measureText(word).width;
  if (initialWidth > maxW && initialWidth > 0) {
    fontSize = Math.max(18, Math.floor(fontSize * (maxW / initialWidth)));
    applyFont(fontSize);
  }
  while (ctx.measureText(word).width > width * 0.9 && fontSize > 16) {
    fontSize -= 1;
    applyFont(fontSize);
  }

  const metrics = ctx.measureText(word);
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.74;
  const descent = metrics.actualBoundingBoxDescent || fontSize * 0.22;
  const baselineY = (height + ascent - descent) / 2;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(word, width / 2, baselineY);

  const data = ctx.getImageData(0, 0, width, height).data;
  const sample = (step: number) => {
    const out: Array<[number, number]> = [];
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        if (data[(y * width + x) * 4 + 3] > 128) out.push([x, y]);
      }
    }
    return out;
  };

  let step = width < 480 ? 3 : 4;
  let pts = sample(step);
  while (pts.length > 1850 && step < 6) {
    step += 1;
    pts = sample(step);
  }

  for (let k = pts.length - 1; k > 0; k--) {
    const j = (Math.random() * (k + 1)) | 0;
    const tmp = pts[k];
    pts[k] = pts[j];
    pts[j] = tmp;
  }
  return { pts, step };
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function ParticleWordmark({ className }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const cv = canvasRef.current;
    if (!root || !cv) return;
    const cx = cv.getContext("2d");
    if (!cx) return;

    const rmQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let rm = rmQuery.matches;

    let W = Math.max(1, Math.round(root.clientWidth));
    let H = Math.max(1, Math.round(root.clientHeight));
    let particles: Particle[] = [];
    let initialized = false;
    let ptr: { x: number; y: number } | null = null;
    let vis = true;
    let raf = 0;
    let last = 0;

    const syncCanvasSize = () => {
      W = Math.max(1, Math.round(root.clientWidth));
      H = Math.max(1, Math.round(root.clientHeight));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const assign = (scatterInitial: boolean) => {
      const { pts, step } = buildTargets(WORD, W, H);
      const dot = getDotSize(W);
      const jitter = Math.max(0, (step - dot) * 0.75);
      let minX = W;
      let maxX = 0;
      for (let i = 0; i < pts.length; i++) {
        if (pts[i][0] < minX) minX = pts[i][0];
        if (pts[i][0] > maxX) maxX = pts[i][0];
      }
      const span = Math.max(1, maxX - minX);
      const count = Math.max(pts.length + 24, 480);

      const next: Particle[] = [];
      for (let i = 0; i < count; i++) {
        const prev = particles[i];
        let tx: number;
        let ty: number;
        let on: boolean;
        let h: number;

        if (i < pts.length) {
          tx = clamp(pts[i][0] + (Math.random() - 0.5) * jitter, MARGIN, W - MARGIN);
          ty = clamp(pts[i][1] + (Math.random() - 0.5) * jitter, MARGIN, H - MARGIN);
          on = true;
          h = clamp(((tx - minX) / span) * 300, 0, 300);
        } else {
          tx = MARGIN + Math.random() * Math.max(1, W - MARGIN * 2);
          ty = MARGIN + Math.random() * Math.max(1, H - MARGIN * 2);
          on = false;
          h = clamp((tx / Math.max(1, W)) * 300, 0, 300);
        }

        const startX =
          scatterInitial || !prev
            ? rm
              ? tx
              : MARGIN + Math.random() * Math.max(1, W - MARGIN * 2)
            : clamp(prev.x, MARGIN, W - MARGIN);
        const startY =
          scatterInitial || !prev
            ? rm
              ? ty
              : MARGIN + Math.random() * Math.max(1, H - MARGIN * 2)
            : clamp(prev.y, MARGIN, H - MARGIN);

        next.push({
          x: startX,
          y: startY,
          vx: prev && !scatterInitial ? prev.vx : 0,
          vy: prev && !scatterInitial ? prev.vy : 0,
          tx,
          ty,
          h,
          on,
        });
      }
      particles = next;
    };

    const draw = () => {
      cx.clearRect(0, 0, W, H);
      cx.globalCompositeOperation = "source-over";
      const dot = getDotSize(W);
      const half = dot * 0.5;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const sp = Math.min(1, Math.hypot(p.vx, p.vy) / 300);
        const hue = Math.max(0, Math.min(315, p.h + sp * 15));
        const sat = (82 + sp * 8).toFixed(0);
        const light = (48 - sp * 6).toFixed(0);
        const alpha = p.on ? 1 : 0.3;
        cx.fillStyle = `hsla(${hue.toFixed(0)},${sat}%,${light}%,${alpha})`;
        cx.fillRect(p.x - half, p.y - half, dot, dot);
      }
    };

    const stopRaf = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (!root.isConnected || !vis) return;
      if (rm) {
        for (let i = 0; i < particles.length; i++) {
          particles[i].x = particles[i].tx;
          particles[i].y = particles[i].ty;
          particles[i].vx = 0;
          particles[i].vy = 0;
        }
        draw();
        return;
      }

      const dt = Math.min(0.033, Math.max(0, (now - last) / 1000));
      last = now;
      let active = Boolean(ptr);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        let ax = (p.tx - p.x) * 38 - p.vx * 7.5;
        let ay = (p.ty - p.y) * 38 - p.vy * 7.5;
        if (ptr) {
          const dx = p.x - ptr.x;
          const dy = p.y - ptr.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 3600) {
            const f = ((1 - d2 / 3600) * 9000) / (Math.sqrt(d2) + 6);
            ax += (dx * f) / 40;
            ay += (dy * f) / 40;
          }
        }
        p.vx += ax * dt;
        p.vy += ay * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        if (p.x < MARGIN) {
          p.x = MARGIN;
          if (p.vx < 0) p.vx *= -0.35;
        } else if (p.x > W - MARGIN) {
          p.x = W - MARGIN;
          if (p.vx > 0) p.vx *= -0.35;
        }
        if (p.y < MARGIN) {
          p.y = MARGIN;
          if (p.vy < 0) p.vy *= -0.35;
        } else if (p.y > H - MARGIN) {
          p.y = H - MARGIN;
          if (p.vy > 0) p.vy *= -0.35;
        }

        if (
          !active &&
          (Math.abs(p.tx - p.x) > 0.15 ||
            Math.abs(p.ty - p.y) > 0.15 ||
            Math.abs(p.vx) > 0.25 ||
            Math.abs(p.vy) > 0.25)
        ) {
          active = true;
        }
      }

      if (!active) {
        for (let i = 0; i < particles.length; i++) {
          particles[i].x = particles[i].tx;
          particles[i].y = particles[i].ty;
          particles[i].vx = 0;
          particles[i].vy = 0;
        }
        draw();
        return;
      }

      draw();
      raf = requestAnimationFrame(frame);
    };

    const run = () => {
      if (rm) {
        stopRaf();
        for (let i = 0; i < particles.length; i++) {
          particles[i].x = particles[i].tx;
          particles[i].y = particles[i].ty;
          particles[i].vx = 0;
          particles[i].vy = 0;
        }
        draw();
        return;
      }
      if (!raf && vis) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    const loc = (e: PointerEvent) => {
      const rect = cv.getBoundingClientRect();
      return {
        x: clamp(((e.clientX - rect.left) / (rect.width || 1)) * W, 0, W),
        y: clamp(((e.clientY - rect.top) / (rect.height || 1)) * H, 0, H),
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      ptr = loc(e);
      run();
    };

    const onPointerLeave = () => {
      ptr = null;
    };

    const onClick = () => {
      if (rm) return;
      for (let i = 0; i < particles.length; i++) {
        particles[i].vx += (Math.random() - 0.5) * 260;
        particles[i].vy += (Math.random() - 0.5) * 260;
      }
      run();
    };

    const onRmChange = (e: MediaQueryListEvent) => {
      rm = e.matches;
      run();
    };

    syncCanvasSize();
    assign(true);
    initialized = true;
    run();

    const ro = new ResizeObserver(() => {
      const nextW = Math.max(1, Math.round(root.clientWidth));
      const nextH = Math.max(1, Math.round(root.clientHeight));
      if (initialized && nextW === W && nextH === H) return;
      syncCanvasSize();
      assign(false);
      run();
    });
    ro.observe(root);

    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver((entries) => {
        vis = entries[0]?.isIntersecting ?? true;
        if (vis) run();
        else stopRaf();
      });
      io.observe(root);
    }

    cv.addEventListener("pointermove", onPointerMove);
    cv.addEventListener("pointerleave", onPointerLeave);
    cv.addEventListener("pointercancel", onPointerLeave);
    cv.addEventListener("click", onClick);
    rmQuery.addEventListener("change", onRmChange);

    return () => {
      stopRaf();
      ro.disconnect();
      io?.disconnect();
      cv.removeEventListener("pointermove", onPointerMove);
      cv.removeEventListener("pointerleave", onPointerLeave);
      cv.removeEventListener("pointercancel", onPointerLeave);
      cv.removeEventListener("click", onClick);
      rmQuery.removeEventListener("change", onRmChange);
    };
  }, []);

  return (
    <div ref={rootRef} className={cn("ux u378", className)}>
      <canvas ref={canvasRef} className="u378-cv" aria-hidden="true" />
      <span className="sr-only">GroupProof</span>
    </div>
  );
}
