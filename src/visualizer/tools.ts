import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  LEGACY_TOOLS,
  configWarnings,
  hasTarget,
  resolveUrl,
  type TargetArgs,
} from "./config.js";
import { IPHONE_SAFE_AREA, session, VisualizerSession, type SessionEvent } from "./session.js";
import { capture, captureBreakpoints, resolveTarget, type CaptureOptions } from "./capture.js";
import {
  collectSnapshot,
  formatSnapshot,
  type SnapshotArgs,
  type SnapshotPayload,
} from "./snapshot.js";
import { compareToBaseline, listBaselines } from "./diff.js";

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
export type ToolResult = {
  content: Array<TextContent | ImageContent>;
  isError?: boolean;
};

// --- Shared schema fragments ------------------------------------------------

const NAV_PROPS = {
  route: { type: "string", description: "Path to visit, e.g. /settings. Omit to act on the page already open." },
  url: { type: "string", description: "Absolute URL. Overrides route/base_url/port." },
  base_url: { type: "string", description: "Base URL override, e.g. https://preview-123.netlify.app" },
  port: { type: "number", description: "Localhost port shorthand. Ignored when base_url is set." },
} as const;

const TARGET_PROPS = {
  ref: { type: "string", description: "Ref from browser_snapshot, e.g. e12. Most reliable — survives class-name churn." },
  selector: { type: "string", description: "CSS selector." },
  find_text: { type: "string", description: "Visible text or accessible name of the control, e.g. \"Sign in\"." },
} as const;

const WAIT_PROPS = {
  wait_for: { type: "string", description: "Wait for a CSS selector, or `text=Some copy`, before continuing." },
  wait_ms: { type: "number", description: "Fixed extra wait in ms (capped at 120000). Prefer wait_for." },
} as const;

const SHOT_PROPS = {
  full_page: { type: "boolean", description: "Capture the whole scroll height instead of just the viewport. Default false — full pages are expensive." },
  max_width: { type: "number", description: "Cap the output width in pixels (default 1000). The image is downscaled to fit." },
  max_height: { type: "number", description: "Cap the output height in pixels (default 4000). Only applies to full_page." },
  format: { type: "string", enum: ["png", "jpeg"], description: "Default png." },
  quality: { type: "number", description: "JPEG quality 1-100 (default 80)." },
} as const;

// --- Result helpers ---------------------------------------------------------

function formatEvent(e: SessionEvent): string {
  if (e.kind === "network") {
    return e.status
      ? `  [HTTP ${e.status}] ${e.method} ${e.url}`
      : `  [network] ${e.method} ${e.url} (${e.text})`;
  }
  if (e.kind === "pageerror") return `  [exception] ${e.text}`;
  if (e.kind === "dialog") return `  [dialog:${e.type}] ${e.text}`;
  return `  [console.${e.type}] ${e.text}`;
}

/** A reload repeats the same errors verbatim; show each line once with a count. */
function collapse(events: SessionEvent[]): string[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const line = formatEvent(event);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return Array.from(counts, ([line, n]) => (n > 1 ? `${line} (×${n})` : line));
}

/** Every result carries the errors the action provoked — no separate call needed. */
function errorTail(mark: number): string {
  const errors = session.errorsSince(mark);
  if (!errors.length) return "";
  const lines = collapse(errors);
  const shown = lines.slice(0, 8).join("\n");
  const rest =
    lines.length > 8
      ? `\n  … ${lines.length - 8} more — call browser_diagnostics`
      : "";
  return `\n\n⚠ ${errors.length} error${errors.length === 1 ? "" : "s"} during this action:\n${shown}${rest}`;
}

function ok(text: string, mark: number, images: ImageContent[] = []): ToolResult {
  return {
    content: [{ type: "text", text: text + errorTail(mark) }, ...images],
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function imageOf(shot: Awaited<ReturnType<typeof capture>>): ImageContent {
  return { type: "image", data: shot.base64, mimeType: shot.mimeType };
}

function shotCaption(shot: Awaited<ReturnType<typeof capture>>): string {
  const notes = shot.notes.length ? ` (${shot.notes.join("; ")})` : "";
  return `${shot.width}×${shot.height}px${notes}`;
}

function targetOf(args: any): { ref?: string; selector?: string; text?: string } {
  return { ref: args.ref, selector: args.selector, text: args.find_text };
}

async function applyWaits(args: any): Promise<void> {
  if (args.wait_for) await session.waitFor(args.wait_for);
  if (args.wait_ms > 0) {
    await new Promise((r) => setTimeout(r, Math.min(args.wait_ms, 120_000)));
  }
}

/** Navigate when the call names a target; otherwise keep working on the open page. */
async function navigateIfTargeted(args: TargetArgs & Record<string, any>): Promise<boolean> {
  if (!hasTarget(args) && session.isOpen()) return false;
  await session.navigate(resolveUrl(args), {
    waitUntil: args.wait_until,
    waitFor: args.wait_for,
  });
  return true;
}

async function emulationFrom(args: any): Promise<string[]> {
  const patch: Record<string, unknown> = {};
  const changes: string[] = [];

  if (args.device !== undefined) {
    if (args.device === null || args.device === "") {
      patch.device = undefined;
      changes.push("device cleared");
    } else if (!VisualizerSession.device(args.device)) {
      throw new Error(
        `Unknown device "${args.device}". Try one of: ${VisualizerSession.deviceNames().slice(0, 12).join(", ")}, …`,
      );
    } else {
      patch.device = args.device;
      changes.push(`device=${args.device}`);
    }
  }
  if (args.width || args.height) {
    const current = session.emulation.viewport;
    patch.viewport = {
      width: args.width ?? current.width,
      height: args.height ?? current.height,
      deviceScaleFactor: current.deviceScaleFactor ?? 1,
    };
    if (args.device === undefined) patch.device = undefined;
    changes.push(`viewport=${(patch.viewport as any).width}×${(patch.viewport as any).height}`);
  }
  if (args.dark !== undefined) {
    patch.dark = Boolean(args.dark);
    changes.push(`prefers-color-scheme=${args.dark ? "dark" : "light"}`);
  }
  if (args.reduced_motion !== undefined) {
    patch.reducedMotion = Boolean(args.reduced_motion);
    changes.push(`reduced-motion=${args.reduced_motion}`);
  }
  if (args.pwa !== undefined) {
    patch.pwa = Boolean(args.pwa);
    if (args.pwa && args.device === undefined && !session.emulation.device) {
      patch.device = "iPhone 15 Pro";
    }
    changes.push(args.pwa ? "pwa/standalone on" : "pwa off");
  }
  if (args.pwa_overlay !== undefined) patch.pwaOverlay = Boolean(args.pwa_overlay);
  if (args.safe_area !== undefined) {
    patch.safeArea = args.safe_area
      ? { ...IPHONE_SAFE_AREA, ...args.safe_area }
      : undefined;
    changes.push("safe-area insets set");
  }

  if (Object.keys(patch).length) await session.setEmulation(patch);
  return changes;
}

// --- Tool definitions -------------------------------------------------------

const CORE_TOOLS: Tool[] = [
  {
    name: "browser_navigate",
    description:
      "Open a route in the persistent browser session. Cookies, localStorage and emulation settings survive between calls, so you can log in once and keep going. Call with only emulation options (no route) to re-configure the page already open.",
    inputSchema: {
      type: "object",
      properties: {
        ...NAV_PROPS,
        ...WAIT_PROPS,
        wait_until: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
          description: "Navigation completion signal. Default domcontentloaded, then a short network-quiet wait.",
        },
        reload: { type: "boolean", description: "Reload the current page instead of navigating." },
        width: { type: "number", description: "Viewport width (default 1280)." },
        height: { type: "number", description: "Viewport height (default 800)." },
        device: { type: "string", description: "Emulate a known device, e.g. \"iPhone 15 Pro\", \"iPad Pro\", \"Pixel 5\". Pass \"\" to clear." },
        dark: { type: "boolean", description: "Emulate prefers-color-scheme: dark." },
        reduced_motion: { type: "boolean", description: "Emulate prefers-reduced-motion: reduce." },
        pwa: { type: "boolean", description: "iOS standalone PWA: display-mode:standalone, navigator.standalone, real env(safe-area-inset-*) via CDP, and an iPhone viewport." },
        pwa_overlay: { type: "boolean", description: "Tint the safe-area bars so they are visible in screenshots. Default true." },
        safe_area: {
          type: "object",
          description: "Explicit safe-area insets in px.",
          properties: {
            top: { type: "number" }, bottom: { type: "number" },
            left: { type: "number" }, right: { type: "number" },
          },
        },
        snapshot: { type: "boolean", description: "Also return the element tree (see browser_snapshot)." },
      },
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Text outline of the page: interactive controls, headings and landmarks, each stamped with a [ref=eN] you can pass to browser_click / browser_type. Far cheaper than a screenshot and removes selector guesswork — take one before interacting.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["interactive", "full"], description: "interactive (default) lists controls and structure; full also includes body text." },
        root: { type: "string", description: "CSS selector to scope the snapshot to one subtree." },
        max_chars: { type: "number", description: "Output cap (default 8000)." },
      },
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Screenshot the current page, or navigate first if a route is given. Defaults to the viewport only; pass a selector/ref to capture one element, which is usually what you want and far cheaper than full_page.",
    inputSchema: {
      type: "object",
      properties: { ...NAV_PROPS, ...TARGET_PROPS, ...WAIT_PROPS, ...SHOT_PROPS },
    },
  },
  {
    name: "browser_click",
    description: "Click, double-click, right-click or hover an element in the live session.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        ...WAIT_PROPS,
        action: { type: "string", enum: ["click", "double", "right", "hover"], description: "Default click." },
        screenshot: { type: "boolean", description: "Return a screenshot of the result. Default false." },
        snapshot: { type: "boolean", description: "Return the refreshed element tree. Default false." },
      },
    },
  },
  {
    name: "browser_type",
    description: "Type into a field in the live session. Set submit:true to press Enter afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        ...WAIT_PROPS,
        text: { type: "string", description: "Text to type." },
        clear: { type: "boolean", description: "Select and delete the existing value first. Default false." },
        submit: { type: "boolean", description: "Press Enter after typing. Default false." },
        delay: { type: "number", description: "Per-keystroke delay in ms, for inputs that debounce." },
        screenshot: { type: "boolean", description: "Return a screenshot of the result. Default false." },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_press",
    description: "Press a key, e.g. Enter, Escape, Tab, ArrowDown, Control+A. Optionally focus an element first.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        ...WAIT_PROPS,
        key: { type: "string", description: "Key or chord, e.g. Enter, Escape, Meta+K." },
        screenshot: { type: "boolean", description: "Return a screenshot of the result. Default false." },
      },
      required: ["key"],
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page to the top or bottom, by a pixel offset, or to bring an element into view.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        to: { type: "string", enum: ["top", "bottom"], description: "Scroll to one end of the page." },
        dy: { type: "number", description: "Scroll down by this many pixels (negative scrolls up)." },
        dx: { type: "number", description: "Scroll right by this many pixels." },
        screenshot: { type: "boolean", description: "Return a screenshot after scrolling. Default false." },
      },
    },
  },
  {
    name: "browser_select",
    description: "Choose one or more options in a <select>.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET_PROPS,
        values: { type: "array", items: { type: "string" }, description: "Option values (not labels) to select." },
        screenshot: { type: "boolean", description: "Return a screenshot of the result. Default false." },
      },
      required: ["values"],
    },
  },
  {
    name: "browser_eval",
    description:
      "Evaluate JavaScript in the page and return the JSON result. Use it to assert app state, read a store, or check a computed style without a screenshot. Async/await is supported.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Expression, or a statement block containing `return`." },
        max_chars: { type: "number", description: "Result cap (default 4000)." },
      },
      required: ["expression"],
    },
  },
  {
    name: "browser_diagnostics",
    description:
      "Console errors and warnings, uncaught exceptions, failed requests and 4xx/5xx responses recorded by the live session. Defaults to everything since the last navigation.",
    inputSchema: {
      type: "object",
      properties: {
        ...NAV_PROPS,
        since: { type: "string", enum: ["navigation", "session"], description: "Default navigation." },
        include_logs: { type: "boolean", description: "Include console warnings, not just errors. Default true." },
        limit: { type: "number", description: "Max entries per section (default 40)." },
      },
    },
  },
  {
    name: "browser_responsive",
    description:
      "Capture the same page at several viewport widths in one call, to check breakpoints side by side.",
    inputSchema: {
      type: "object",
      properties: {
        ...NAV_PROPS,
        ...WAIT_PROPS,
        widths: { type: "array", items: { type: "number" }, description: "Viewport widths (default [375, 768, 1280]). Max 4." },
        height: { type: "number", description: "Viewport height for each capture (default 900)." },
        full_page: { type: "boolean", description: "Capture full scroll height at each width. Default false." },
        max_width: { type: "number", description: "Cap each output image's width (default 600 here, to keep the set affordable)." },
        format: { type: "string", enum: ["png", "jpeg"] },
      },
    },
  },
  {
    name: "browser_diff",
    description:
      "Compare the current page against a saved baseline screenshot and report what changed. The first call for a name stores the baseline; later calls diff against it. Use it to catch unintended visual regressions after a refactor.",
    inputSchema: {
      type: "object",
      properties: {
        ...NAV_PROPS,
        ...TARGET_PROPS,
        ...WAIT_PROPS,
        name: { type: "string", description: "Baseline name, e.g. \"dashboard-desktop\"." },
        update: { type: "boolean", description: "Overwrite the baseline with the current render." },
        threshold: { type: "number", description: "Per-pixel colour tolerance 0-1 (default 0.1). Higher ignores more." },
        include_image: { type: "boolean", description: "Return the highlighted diff image. Default true." },
        full_page: SHOT_PROPS.full_page,
        max_width: SHOT_PROPS.max_width,
        max_height: SHOT_PROPS.max_height,
        list: { type: "boolean", description: "Just list the stored baseline names." },
      },
    },
  },
  {
    name: "browser_close",
    description:
      "Close the browser session. Use it to drop auth/cookies and start clean; the session otherwise closes itself after an idle period.",
    inputSchema: { type: "object", properties: {} },
  },
];

const LEGACY: Tool[] = [
  {
    name: "screenshot_page",
    description: "Legacy one-shot: navigate and screenshot. Prefer browser_navigate + browser_screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string", description: "Path to visit (e.g. /ats)" },
        base_url: NAV_PROPS.base_url,
        port: NAV_PROPS.port,
        mobile: { type: "boolean" },
        pwa: { type: "boolean", description: "Simulate an iOS standalone PWA with real safe-area insets." },
        wait_ms: WAIT_PROPS.wait_ms,
      },
      required: ["route"],
    },
  },
  {
    name: "type_into_element",
    description: "Legacy one-shot: navigate, type into a selector, screenshot. Prefer browser_type.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        base_url: NAV_PROPS.base_url,
        port: NAV_PROPS.port,
        wait_ms: WAIT_PROPS.wait_ms,
      },
      required: ["route", "selector", "text"],
    },
  },
  {
    name: "inspect_network_errors",
    description: "Legacy one-shot: navigate and report console/network errors. Prefer browser_diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string" },
        base_url: NAV_PROPS.base_url,
        port: NAV_PROPS.port,
        include_logs: { type: "boolean", default: true },
      },
      required: ["route"],
    },
  },
];

export const tools: Tool[] = LEGACY_TOOLS ? [...CORE_TOOLS, ...LEGACY] : CORE_TOOLS;

// --- Dispatch ---------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function extraWait(args: any, alreadyWaited: boolean): Promise<void> {
  if (!alreadyWaited && args.wait_for) await session.waitFor(args.wait_for);
  if (args.wait_ms > 0) await sleep(Math.min(args.wait_ms, 120_000));
}

async function snapshotText(args: any): Promise<string> {
  const page = await session.page();
  const snapshotArgs: SnapshotArgs = {
    mode: args.mode === "full" ? "full" : "interactive",
    root: args.root,
  };
  const payload = (await page.evaluate(
    collectSnapshot,
    snapshotArgs,
  )) as SnapshotPayload;
  return formatSnapshot(payload, args.max_chars ?? 8000);
}

async function pageHeading(): Promise<string> {
  const page = await session.page();
  const title = await page.title().catch(() => "");
  return `${title || "(untitled)"} — ${page.url()}`;
}

async function maybeAttachments(
  args: any,
): Promise<{ text: string; images: ImageContent[] }> {
  const images: ImageContent[] = [];
  let text = "";
  if (args.screenshot) {
    const shot = await capture(args as CaptureOptions);
    text += `\nScreenshot: ${shotCaption(shot)}`;
    images.push(imageOf(shot));
  }
  if (args.snapshot) text += `\n\n${await snapshotText(args)}`;
  return { text, images };
}

function buildDiagnostics(
  since: number,
  includeLogs: boolean,
  limit: number,
): string {
  const events = session.eventsSince(since);
  const network = events.filter((e) => e.kind === "network");
  const console_ = events.filter(
    (e) =>
      e.kind === "pageerror" ||
      (e.kind === "console" && (includeLogs || e.type === "error")),
  );
  const dialogs = events.filter((e) => e.kind === "dialog");

  const section = (title: string, list: SessionEvent[], empty: string) => {
    if (!list.length) return `[${title}]\n  ${empty}`;
    const lines = collapse(list);
    const shown = lines.slice(-limit).join("\n");
    const more =
      lines.length > limit ? `\n  … ${lines.length - limit} older entries omitted` : "";
    return `[${title}] ${list.length}\n${shown}${more}`;
  };

  const parts = [
    section("NETWORK", network, "No failed or 4xx/5xx requests."),
    section("CONSOLE & EXCEPTIONS", console_, "Nothing logged."),
  ];
  if (dialogs.length) parts.push(section("DIALOGS", dialogs, ""));
  return parts.join("\n\n");
}

export async function callTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  const args: any = rawArgs ?? {};
  const mark = session.mark();

  try {
    switch (name) {
      case "browser_navigate": {
        // Changing device/viewport makes puppeteer reload, which would re-run
        // the current app for nothing and double its errors in the report.
        const willNavigate = Boolean(args.reload) || hasTarget(args) || !session.isOpen();
        if (willNavigate && (args.device !== undefined || args.width || args.height || args.pwa !== undefined)) {
          await session.blank();
        }
        const changes = await emulationFrom(args);
        let navigated = false;
        if (args.reload) {
          await session.reload({ waitFor: args.wait_for });
          navigated = true;
        } else {
          navigated = await navigateIfTargeted(args);
        }
        await extraWait(args, navigated);

        const lines = [navigated ? "Loaded" : "Reconfigured", await pageHeading()];
        if (changes.length) lines.push(`Emulation: ${changes.join(", ")}`);
        const extra = args.snapshot ? `\n\n${await snapshotText(args)}` : "";
        return ok(`${lines[0]} ${lines[1]}${lines[2] ? `\n${lines[2]}` : ""}${extra}`, mark);
      }

      case "browser_snapshot":
        return ok(await snapshotText(args), mark);

      case "browser_screenshot": {
        const navigated = await navigateIfTargeted(args);
        await extraWait(args, navigated);
        const shot = await capture({ ...targetOf(args), ...args });
        return ok(
          `${await pageHeading()}\nScreenshot: ${shotCaption(shot)}`,
          mark,
          [imageOf(shot)],
        );
      }

      case "browser_click": {
        const page = await session.page();
        const element = await resolveTarget(page, targetOf(args));
        await element.scrollIntoView().catch(() => {});
        const action = args.action ?? "click";
        if (action === "hover") await element.hover();
        else if (action === "double") await element.click({ count: 2 });
        else if (action === "right") await element.click({ button: "right" });
        else await element.click();
        await element.dispose().catch(() => {});

        await session.settleAfterAction(args.wait_for).catch(() => {});
        if (args.wait_ms > 0) await sleep(Math.min(args.wait_ms, 120_000));

        const { text, images } = await maybeAttachments(args);
        return ok(`${action} → ${await pageHeading()}${text}`, mark, images);
      }

      case "browser_type": {
        const page = await session.page();
        const element = await resolveTarget(page, targetOf(args));
        await element.scrollIntoView().catch(() => {});
        if (args.clear) {
          // Triple-click + delete fires the events controlled inputs listen for.
          await element.click({ count: 3 });
          await page.keyboard.press("Backspace");
        } else {
          await element.focus();
        }
        await element.type(String(args.text), { delay: args.delay ?? 0 });
        if (args.submit) await page.keyboard.press("Enter");
        await element.dispose().catch(() => {});

        await session.settleAfterAction(args.wait_for).catch(() => {});
        if (args.wait_ms > 0) await sleep(Math.min(args.wait_ms, 120_000));

        const { text, images } = await maybeAttachments(args);
        const what = args.submit ? "Typed and submitted" : "Typed";
        return ok(`${what} → ${await pageHeading()}${text}`, mark, images);
      }

      case "browser_press": {
        const page = await session.page();
        if (args.ref || args.selector || args.find_text) {
          const element = await resolveTarget(page, targetOf(args));
          await element.focus();
          await element.dispose().catch(() => {});
        }
        const parts = String(args.key).split("+");
        const key = parts.pop() as never;
        for (const modifier of parts) await page.keyboard.down(modifier as never);
        await page.keyboard.press(key);
        for (const modifier of parts.reverse()) {
          await page.keyboard.up(modifier as never);
        }

        await session.settleAfterAction(args.wait_for).catch(() => {});
        if (args.wait_ms > 0) await sleep(Math.min(args.wait_ms, 120_000));

        const { text, images } = await maybeAttachments(args);
        return ok(`Pressed ${args.key} → ${await pageHeading()}${text}`, mark, images);
      }

      case "browser_scroll": {
        const page = await session.page();
        if (args.ref || args.selector || args.find_text) {
          const element = await resolveTarget(page, targetOf(args));
          await element.scrollIntoView();
          await element.dispose().catch(() => {});
        } else if (args.to === "top") {
          await page.evaluate(() => window.scrollTo(0, 0));
        } else if (args.to === "bottom") {
          await page.evaluate(() =>
            window.scrollTo(0, document.documentElement.scrollHeight),
          );
        } else {
          const dx = Number(args.dx) || 0;
          const dy = Number(args.dy) || 0;
          await page.evaluate(
            (x: number, y: number) => window.scrollBy(x, y),
            dx,
            dy,
          );
        }
        await sleep(150);
        const position = await page.evaluate(() => ({
          y: Math.round(window.scrollY),
          max: Math.round(
            document.documentElement.scrollHeight - window.innerHeight,
          ),
        }));
        const { text, images } = await maybeAttachments(args);
        return ok(`Scrolled to y=${position.y} of ${position.max}${text}`, mark, images);
      }

      case "browser_select": {
        const page = await session.page();
        const element = await resolveTarget(page, targetOf(args));
        const selected = await element.select(...(args.values as string[]));
        await element.dispose().catch(() => {});
        await session.settleAfterAction(args.wait_for).catch(() => {});
        const { text, images } = await maybeAttachments(args);
        return ok(`Selected ${JSON.stringify(selected)}${text}`, mark, images);
      }

      case "browser_eval": {
        const page = await session.page();
        const expression = String(args.expression);
        const wrapped = /\breturn\b/.test(expression)
          ? `(async () => { ${expression} })()`
          : `(async () => (${expression}))()`;
        const result = await page.evaluate(wrapped);
        let text: string;
        try {
          text = JSON.stringify(result, null, 2) ?? String(result);
        } catch {
          text = String(result);
        }
        const cap = args.max_chars ?? 4000;
        if (text.length > cap) text = `${text.slice(0, cap)}\n… (truncated)`;
        return ok(text, mark);
      }

      case "browser_diagnostics": {
        await navigateIfTargeted(args);
        const since = args.since === "session" ? 0 : session.lastNavSeq;
        const report = buildDiagnostics(
          since,
          args.include_logs !== false,
          args.limit ?? 40,
        );
        const scope = args.since === "session" ? "this session" : "the last navigation";
        return {
          content: [
            {
              type: "text",
              text: `Diagnostics for ${await pageHeading()}\nScope: since ${scope}\n\n${report}`,
            },
          ],
        };
      }

      case "browser_responsive": {
        const navigated = await navigateIfTargeted(args);
        await extraWait(args, navigated);
        const widths: number[] = Array.isArray(args.widths) && args.widths.length
          ? args.widths.slice(0, 4).map(Number)
          : [375, 768, 1280];
        const shots = await captureBreakpoints(widths, {
          full_page: args.full_page,
          max_width: args.max_width ?? 600,
          format: args.format,
        });

        const content: Array<TextContent | ImageContent> = [
          {
            type: "text",
            text: `${await pageHeading()}\nBreakpoints: ${widths.join(", ")}px${errorTail(mark)}`,
          },
        ];
        for (const { width, capture: shot } of shots) {
          content.push({ type: "text", text: `— ${width}px viewport (${shotCaption(shot)})` });
          content.push(imageOf(shot));
        }
        return { content };
      }

      case "browser_diff": {
        if (args.list) {
          const names = await listBaselines();
          return ok(
            names.length
              ? `Stored baselines:\n${names.map((n) => `  - ${n}`).join("\n")}`
              : "No baselines stored yet.",
            mark,
          );
        }
        if (!args.name) return fail("`name` is required (or pass list:true).");

        const navigated = await navigateIfTargeted(args);
        await extraWait(args, navigated);
        const shot = await capture({
          ...targetOf(args),
          full_page: args.full_page,
          max_width: args.max_width,
          max_height: args.max_height,
          format: "png",
        });
        const outcome = await compareToBaseline(shot.buffer, args.name, {
          update: args.update,
          threshold: args.threshold,
        });

        if (outcome.status === "created" || outcome.status === "updated") {
          return ok(
            `Baseline "${args.name}" ${outcome.status} (${shot.width}×${shot.height}px)\n${outcome.file}`,
            mark,
            [imageOf(shot)],
          );
        }
        if (outcome.status === "size-mismatch") {
          return ok(
            `Baseline "${args.name}" is ${outcome.baseline.width}×${outcome.baseline.height}px but this render is ${outcome.actual.width}×${outcome.actual.height}px, so they cannot be compared pixel by pixel.\nEither match the capture settings used for the baseline, or re-record it with update:true.`,
            mark,
          );
        }
        if (outcome.status === "match") {
          return ok(
            `No visual change against baseline "${args.name}" (${outcome.width}×${outcome.height}px).`,
            mark,
          );
        }

        const box = outcome.box
          ? `changed region: ${outcome.box.width}×${outcome.box.height}px at (${outcome.box.x}, ${outcome.box.y})`
          : "changed region: n/a";
        const images: ImageContent[] =
          args.include_image === false
            ? []
            : [
                {
                  type: "image",
                  data: outcome.diffPng.toString("base64"),
                  mimeType: "image/png",
                },
              ];
        return ok(
          `Visual change against baseline "${args.name}":\n` +
            `  ${outcome.changedPixels.toLocaleString()} pixels differ (${outcome.changedPercent.toFixed(2)}% of ${outcome.width}×${outcome.height})\n` +
            `  ${box}\n` +
            `Diff image highlights changed pixels in red. Accept this render with update:true.`,
          mark,
          images,
        );
      }

      case "browser_close":
        await session.reset();
        return { content: [{ type: "text", text: "Browser session closed." }] };

      // --- Legacy one-shot wrappers ---
      case "screenshot_page": {
        const isMobile = Boolean(args.mobile || args.pwa);
        await session.blank();
        await session.setEmulation({
          device: isMobile ? "iPhone 15 Pro" : undefined,
          pwa: Boolean(args.pwa),
        });
        await session.navigate(resolveUrl(args));
        await extraWait(args, false);
        const shot = await capture({ full_page: !isMobile });
        return ok(
          `Action performed on ${resolveUrl(args)}\nScreenshot: ${shotCaption(shot)}`,
          mark,
          [imageOf(shot)],
        );
      }

      case "type_into_element": {
        await session.navigate(resolveUrl(args));
        const page = await session.page();
        const element = await resolveTarget(page, { selector: args.selector });
        await element.focus();
        await element.type(String(args.text));
        await element.dispose().catch(() => {});
        await extraWait(args, false);
        const shot = await capture({ full_page: true });
        return ok(
          `Action performed on ${resolveUrl(args)}\nScreenshot: ${shotCaption(shot)}`,
          mark,
          [imageOf(shot)],
        );
      }

      case "inspect_network_errors": {
        await session.navigate(resolveUrl(args));
        const report = buildDiagnostics(
          session.lastNavSeq,
          args.include_logs !== false,
          40,
        );
        return {
          content: [
            {
              type: "text",
              text: `Diagnostic Report for ${resolveUrl(args)}\n${"=".repeat(40)}\n\n${report}`,
            },
          ],
        };
      }

      default:
        return fail(`Unknown tool "${name}".`);
    }
  } catch (err) {
    const warnings = configWarnings();
    const suffix = warnings.length ? `\n\nNote: ${warnings.join(" ")}` : "";
    return fail(`${(err as Error).message}${suffix}`);
  }
}
