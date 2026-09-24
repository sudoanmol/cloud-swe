"use client";

import { useEffect, useRef } from "react";

/**
 * Decorative monochrome pixel field approximating the referenced Vercel Labs
 * background. Local canvas only: no transplanted bundle, no hotlinked asset,
 * no branding. It stays behind accessible DOM text and cleans up on unmount.
 */
const CELL_PX = 12;

const MAX_DEVICE_PIXEL_RATIO = 2;

const TARGET_FPS = 30;

/** Cells near the centre fade out so the wordmark and button stay legible. */
const CENTRE_CLEAR_RADIUS = 0.55;

const POINTER_CHARGE_RADIUS = 2.5;

export function PixelField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) return;

    const context = canvas.getContext("2d");

    // No canvas support: the containing surface keeps its CSS gradient.
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: -1, y: -1 };
    let width = 0;
    let height = 0;
    let columns = 0;
    let rows = 0;
    let charge = new Float32Array(0);
    let phase = new Float32Array(0);
    let speed = new Float32Array(0);
    let frame = 0;
    let lastDrawnAt = 0;

    const seed = () => {
      const count = columns * rows;

      charge = new Float32Array(count);
      phase = new Float32Array(count);
      speed = new Float32Array(count);

      for (let index = 0; index < count; index += 1) {
        phase[index] = Math.random() * Math.PI * 2;
        speed[index] = 0.15 + Math.random() * 0.35;
      }
    };

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);

      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      columns = Math.max(1, Math.ceil(width / CELL_PX));
      rows = Math.max(1, Math.ceil(height / CELL_PX));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      seed();
    };

    const addCharge = (x: number, y: number) => {
      const centreColumn = Math.floor(x / CELL_PX);
      const centreRow = Math.floor(y / CELL_PX);

      for (let row = centreRow - 2; row <= centreRow + 2; row += 1) {
        for (let column = centreColumn - 2; column <= centreColumn + 2; column += 1) {
          if (row < 0 || column < 0 || row >= rows || column >= columns) continue;

          const distance = Math.hypot(row - centreRow, column - centreColumn);
          const index = row * columns + column;

          if (distance > POINTER_CHARGE_RADIUS) continue;

          charge[index] = Math.min(
            1.6,
            charge[index] + (1 - distance / POINTER_CHARGE_RADIUS) * 0.5,
          );
        }
      }
    };

    const draw = (elapsedMs: number) => {
      const seconds = elapsedMs / 1_000;

      context.clearRect(0, 0, width, height);
      context.fillStyle = "rgb(255 255 255)";

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const index = row * columns + column;
          const x = column * CELL_PX + CELL_PX / 2;
          const y = row * CELL_PX + CELL_PX / 2;
          const wave = 0.5 + 0.5 * Math.sin(seconds * speed[index] + phase[index]);
          let intensity = wave * 0.35;

          if (charge[index] > 0.01) {
            intensity += Math.min(charge[index], 1) * 0.9;
            charge[index] *= 0.93;
          }

          const offsetX = (x - width / 2) / (width / 2);
          const offsetY = (y - height / 2) / (height / 2);

          intensity *= Math.min(1, Math.hypot(offsetX, offsetY) / CENTRE_CLEAR_RADIUS);

          if (intensity <= 0.04) continue;

          const size = 2 + intensity * 5;

          context.globalAlpha = Math.min(0.85, intensity);
          context.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }

      if (pointer.x >= 0) {
        const glow = context.createRadialGradient(
          pointer.x,
          pointer.y,
          0,
          pointer.x,
          pointer.y,
          220,
        );

        glow.addColorStop(0, "rgb(255 255 255 / 0.07)");
        glow.addColorStop(1, "rgb(255 255 255 / 0)");
        context.globalAlpha = 1;
        context.fillStyle = glow;
        context.fillRect(pointer.x - 220, pointer.y - 220, 440, 440);
        context.fillStyle = "rgb(255 255 255)";
      }

      context.globalAlpha = 1;
    };

    const tick = (elapsedMs: number) => {
      if (elapsedMs - lastDrawnAt >= 1_000 / TARGET_FPS) {
        lastDrawnAt = elapsedMs;
        draw(elapsedMs);
      }

      frame = window.requestAnimationFrame(tick);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();

      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
      addCharge(pointer.x, pointer.y);
    };

    const handlePointerLeave = () => {
      pointer.x = -1;
      pointer.y = -1;
    };

    resize();

    if (reduceMotion) {
      draw(0);

      return;
    }

    const observer = new ResizeObserver(() => {
      resize();
    });

    observer.observe(canvas);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerleave", handlePointerLeave);
    frame = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, []);

  return <canvas aria-hidden="true" className={className} ref={canvasRef} />;
}
