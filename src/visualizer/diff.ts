import fs from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { BASELINE_DIR } from "./config.js";

export type DiffOutcome =
  | { status: "created"; file: string }
  | { status: "updated"; file: string }
  | {
      status: "size-mismatch";
      file: string;
      baseline: { width: number; height: number };
      actual: { width: number; height: number };
    }
  | {
      status: "match" | "changed";
      file: string;
      width: number;
      height: number;
      changedPixels: number;
      changedPercent: number;
      box: { x: number; y: number; width: number; height: number } | null;
      diffPng: Buffer;
    };

function safeName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "baseline";
}

export function baselinePath(name: string): string {
  return path.join(BASELINE_DIR, `${safeName(name)}.png`);
}

/** Bounding box of every pixel whose channels differ beyond `tolerance`. */
function changedBox(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  tolerance = 20,
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const delta =
        Math.abs(a[i] - b[i]) +
        Math.abs(a[i + 1] - b[i + 1]) +
        Math.abs(a[i + 2] - b[i + 2]) +
        Math.abs(a[i + 3] - b[i + 3]);
      if (delta > tolerance) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export async function compareToBaseline(
  actualPng: Buffer,
  name: string,
  opts: { update?: boolean; threshold?: number } = {},
): Promise<DiffOutcome> {
  const file = baselinePath(name);
  await fs.mkdir(path.dirname(file), { recursive: true });

  let existing: Buffer | null = null;
  try {
    existing = await fs.readFile(file);
  } catch {
    existing = null;
  }

  if (!existing || opts.update) {
    await fs.writeFile(file, actualPng);
    return { status: existing ? "updated" : "created", file };
  }

  const baseline = PNG.sync.read(existing);
  const actual = PNG.sync.read(actualPng);

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      status: "size-mismatch",
      file,
      baseline: { width: baseline.width, height: baseline.height },
      actual: { width: actual.width, height: actual.height },
    };
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });
  const changedPixels = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    width,
    height,
    { threshold: opts.threshold ?? 0.1, includeAA: false, alpha: 0.25 },
  );

  const total = width * height;
  const changedPercent = total ? (changedPixels / total) * 100 : 0;

  return {
    status: changedPixels === 0 ? "match" : "changed",
    file,
    width,
    height,
    changedPixels,
    changedPercent,
    box: changedPixels === 0 ? null : changedBox(baseline.data, actual.data, width, height),
    diffPng: PNG.sync.write(diff),
  };
}

export async function listBaselines(): Promise<string[]> {
  try {
    const files = await fs.readdir(BASELINE_DIR);
    return files.filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)).sort();
  } catch {
    return [];
  }
}
