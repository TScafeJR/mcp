import type { ElementHandle, Page } from "puppeteer";
import { DEFAULT_MAX_HEIGHT, DEFAULT_MAX_WIDTH } from "./config.js";
import { session } from "./session.js";
import { REF_ATTR } from "./snapshot.js";

export type TargetSpec = { ref?: string; selector?: string; text?: string };

export type CaptureOptions = TargetSpec & {
  full_page?: boolean;
  max_width?: number;
  max_height?: number;
  format?: "png" | "jpeg";
  quality?: number;
};

export type Capture = {
  buffer: Buffer;
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  notes: string[];
};

/**
 * Resolves an element from a snapshot ref, a CSS selector, or visible text.
 * Refs are preferred — they survive re-renders that break hand-written selectors.
 */
export async function resolveTarget(
  page: Page,
  spec: TargetSpec,
  timeout = 5_000,
): Promise<ElementHandle<Element>> {
  if (spec.ref) {
    const selector = `[${REF_ATTR}="${spec.ref.replace(/"/g, "")}"]`;
    const handle = await page.$(selector);
    if (!handle) {
      throw new Error(
        `ref "${spec.ref}" is no longer on the page — it was invalidated by a navigation or re-render. Take a fresh browser_snapshot and use the new ref.`,
      );
    }
    return handle;
  }

  if (spec.selector) {
    try {
      const handle = await page.waitForSelector(spec.selector, { timeout });
      if (handle) return handle;
    } catch {
      /* fall through to the shared error below */
    }
    throw new Error(
      `No element matched selector "${spec.selector}" within ${timeout}ms. Run browser_snapshot to see what is actually on the page.`,
    );
  }

  if (spec.text) {
    const handle = await page.evaluateHandle((needle: string) => {
      const wanted = needle.toLowerCase();
      const candidates = Array.from(
        document.querySelectorAll(
          "a,button,input,select,textarea,summary,[role],[onclick],[tabindex]",
        ),
      );
      const nameOf = (el: Element): string => {
        const aria = el.getAttribute("aria-label");
        if (aria) return aria;
        const tag = el.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") {
          // Named by its label first — that is what browser_snapshot reports.
          const id = (el as HTMLElement).id;
          const label = id
            ? document.querySelector(`label[for="${CSS.escape(id)}"]`)
            : el.closest("label");
          const labelText = label?.textContent?.trim();
          if (labelText) return labelText;
          const input = el as HTMLInputElement;
          return input.placeholder || input.value || input.name || "";
        }
        return (el as HTMLElement).innerText || el.textContent || "";
      };
      const visible = (el: Element) => el.getClientRects().length > 0;

      let exact: Element | null = null;
      let partial: Element | null = null;
      for (const el of candidates) {
        if (!visible(el)) continue;
        const name = nameOf(el).replace(/\s+/g, " ").trim().toLowerCase();
        if (!name) continue;
        if (name === wanted) {
          exact = el;
          break;
        }
        if (!partial && name.includes(wanted)) partial = el;
      }
      return exact || partial;
    }, spec.text);

    const element = handle.asElement() as ElementHandle<Element> | null;
    if (!element) {
      throw new Error(
        `No visible interactive element matched text "${spec.text}". Run browser_snapshot to see the available controls.`,
      );
    }
    return element;
  }

  throw new Error("Pass one of `ref`, `selector`, or `text` to target an element.");
}

/**
 * Screenshots cost tokens in proportion to pixel area, so downscale by lowering
 * the device scale factor rather than capturing at full resolution.
 */
export async function capture(opts: CaptureOptions = {}): Promise<Capture> {
  const page = await session.page();
  const notes: string[] = [];
  const viewport = { ...(page.viewport() ?? { width: 1280, height: 800, deviceScaleFactor: 1 }) };
  const baseScale = viewport.deviceScaleFactor ?? 1;
  const maxWidth = opts.max_width ?? DEFAULT_MAX_WIDTH;
  const maxHeight = opts.max_height ?? DEFAULT_MAX_HEIGHT;
  const format = opts.format ?? "png";
  const targeted = Boolean(opts.ref || opts.selector || opts.text);

  let element: ElementHandle<Element> | null = null;
  let cssWidth = viewport.width;
  let doc: { width: number; height: number } | null = null;

  if (targeted) {
    element = await resolveTarget(page, opts);
    await element.scrollIntoView().catch(() => {});
    const box = await element.boundingBox();
    if (!box || box.width === 0 || box.height === 0) {
      throw new Error(
        "The targeted element has no visible box (zero size or display:none), so it cannot be screenshotted.",
      );
    }
    cssWidth = box.width;
  } else if (opts.full_page) {
    doc = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    cssWidth = doc.width;
  }

  const scale = Math.min(baseScale, maxWidth / cssWidth);
  const rescaled = Math.abs(scale - baseScale) > 0.01;
  if (rescaled) {
    await page.setViewport({ ...viewport, deviceScaleFactor: scale });
  }

  try {
    const type = format;
    const quality = format === "jpeg" ? (opts.quality ?? 80) : undefined;
    let raw: Uint8Array;
    let outWidth = Math.round(cssWidth * scale);
    let outHeight = Math.round(viewport.height * scale);

    if (element) {
      const box = await element.boundingBox();
      raw = await element.screenshot({ type, quality });
      if (box) {
        outWidth = Math.round(box.width * scale);
        outHeight = Math.round(box.height * scale);
      }
    } else if (opts.full_page && doc) {
      const maxCssHeight = maxHeight / scale;
      if (doc.height > maxCssHeight) {
        raw = await page.screenshot({
          type,
          quality,
          clip: { x: 0, y: 0, width: doc.width, height: maxCssHeight },
        });
        outWidth = Math.round(doc.width * scale);
        outHeight = maxHeight;
        notes.push(
          `page is ${Math.round(doc.height)}px tall — captured the top ${Math.round(maxCssHeight)}px. Raise \`max_height\`, or screenshot a \`selector\` instead.`,
        );
      } else {
        raw = await page.screenshot({ type, quality, fullPage: true });
        outWidth = Math.round(doc.width * scale);
        outHeight = Math.round(doc.height * scale);
      }
    } else {
      raw = await page.screenshot({ type, quality });
    }

    if (rescaled) {
      notes.push(
        `downscaled ${Math.round(scale * 100) / 100}× to stay under max_width=${maxWidth}`,
      );
    }

    const buffer = Buffer.from(raw);
    const actual = imageSize(buffer);
    return {
      buffer,
      base64: buffer.toString("base64"),
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      width: actual?.width ?? outWidth,
      height: actual?.height ?? outHeight,
      notes,
    };
  } finally {
    if (rescaled) {
      await page.setViewport(viewport).catch(() => {});
    }
    if (element) await element.dispose().catch(() => {});
  }
}

export type BreakpointCapture = { width: number; capture: Capture };

/** Same page, several viewport widths, one call — for checking breakpoints. */
export async function captureBreakpoints(
  widths: number[],
  opts: CaptureOptions & { height?: number; settle_ms?: number } = {},
): Promise<BreakpointCapture[]> {
  const page = await session.page();
  const original = { ...(page.viewport() ?? { width: 1280, height: 800, deviceScaleFactor: 1 }) };
  const height = opts.height ?? 900;
  const results: BreakpointCapture[] = [];

  try {
    for (const width of widths) {
      await page.setViewport({ ...original, width, height, deviceScaleFactor: 1 });
      // Give layout, resize listeners and lazy images a beat to catch up.
      await new Promise((r) => setTimeout(r, opts.settle_ms ?? 350));
      await session.waitForNetworkQuiet(200, 2_000);
      results.push({ width, capture: await capture({ ...opts, ref: undefined, text: undefined }) });
    }
  } finally {
    await page.setViewport(original).catch(() => {});
  }

  return results;
}

/** Reads the real pixel dimensions out of the encoded image. */
function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
