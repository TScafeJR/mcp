import puppeteer, {
  Browser,
  CDPSession,
  Page,
  KnownDevices,
  type Device,
  type Viewport,
} from "puppeteer";
import {
  DEFAULT_VIEWPORT,
  HEADLESS,
  IDLE_MS,
  MAX_EVENTS,
  NAV_TIMEOUT,
  SETTLE_TIMEOUT,
  basicAuth,
  extraHeaders,
} from "./config.js";

export type EventKind = "console" | "pageerror" | "network" | "dialog";

export type SessionEvent = {
  seq: number;
  kind: EventKind;
  type: string;
  text: string;
  url?: string;
  method?: string;
  status?: number;
};

export type SafeAreaInsets = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type EmulationState = {
  viewport: Viewport;
  device?: string;
  dark: boolean;
  reducedMotion: boolean;
  pwa: boolean;
  pwaOverlay: boolean;
  safeArea?: SafeAreaInsets;
};

export const IPHONE_SAFE_AREA: SafeAreaInsets = {
  top: 59,
  bottom: 34,
  left: 0,
  right: 0,
};

const DEFAULT_EMULATION = (): EmulationState => ({
  viewport: { ...DEFAULT_VIEWPORT },
  dark: false,
  reducedMotion: false,
  pwa: false,
  pwaOverlay: true,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Requests nobody wants reported as an app error. */
const isNoise = (url: string): boolean => /\/favicon\.ico(\?|$)/.test(url);

/** Chromium is slow to start; keep one alive between calls so journeys work. */
class VisualizerSession {
  private browser: Browser | null = null;
  private currentPage: Page | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pwaScriptId: string | null = null;
  private cdp: CDPSession | null = null;
  private defaultUserAgent = "";

  private events: SessionEvent[] = [];
  private seq = 0;
  private inflight = 0;
  lastNavSeq = 0;
  startedAt = 0;
  emulation: EmulationState = DEFAULT_EMULATION();

  /** Monotonic cursor a tool grabs before acting, to report only what it caused. */
  mark(): number {
    return this.seq;
  }

  eventsSince(seq: number, kinds?: EventKind[]): SessionEvent[] {
    return this.events.filter((e) => e.seq > seq && (!kinds || kinds.includes(e.kind)));
  }

  /** Errors only — cheap enough to append to every tool result. */
  errorsSince(seq: number): SessionEvent[] {
    return this.eventsSince(seq).filter(
      (e) =>
        e.kind === "pageerror" ||
        (e.kind === "console" && e.type === "error") ||
        (e.kind === "network" && (e.status === undefined || e.status >= 400)),
    );
  }

  private record(event: Omit<SessionEvent, "seq">): void {
    this.events.push({ ...event, seq: ++this.seq });
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  isOpen(): boolean {
    return Boolean(this.browser?.connected && this.currentPage && !this.currentPage.isClosed());
  }

  /** Any tool call keeps the session alive for another idle window. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  async page(): Promise<Page> {
    this.touch();
    if (this.isOpen()) return this.currentPage as Page;

    await this.close();

    this.browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    this.browser.on("disconnected", () => {
      this.browser = null;
      this.currentPage = null;
    });

    this.defaultUserAgent = await this.browser.userAgent();
    const page = await this.browser.newPage();
    this.currentPage = page;
    this.cdp = null;
    this.startedAt = Date.now();

    this.wire(page);

    const headers = extraHeaders();
    if (headers) await page.setExtraHTTPHeaders(headers);
    const auth = basicAuth();
    if (auth) await page.authenticate(auth);

    await this.applyEmulation();
    return page;
  }

  private wire(page: Page): void {
    page.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warn") return;
      const text = msg.text();
      // The network entry already reports this; logging both doubles the noise.
      if (/^Failed to load resource/.test(text)) return;
      this.record({
        kind: "console",
        type: type === "warn" ? "warning" : "error",
        text,
        url: msg.location()?.url,
      });
    });

    page.on("pageerror", (err) => {
      this.record({
        kind: "pageerror",
        type: "exception",
        text: (err as Error).message,
      });
    });

    page.on("requestfailed", (req) => {
      this.inflight = Math.max(0, this.inflight - 1);
      // Aborted requests are routine (cancelled prefetches, navigations away).
      const failure = req.failure()?.errorText || "unknown";
      if (failure === "net::ERR_ABORTED" || isNoise(req.url())) return;
      this.record({
        kind: "network",
        type: "failed",
        text: failure,
        url: req.url(),
        method: req.method(),
      });
    });

    page.on("request", () => {
      this.inflight++;
    });
    page.on("requestfinished", () => {
      this.inflight = Math.max(0, this.inflight - 1);
    });

    page.on("response", (res) => {
      if (res.status() < 400 || isNoise(res.url())) return;
      this.record({
        kind: "network",
        type: "http",
        text: res.statusText() || String(res.status()),
        url: res.url(),
        method: res.request().method(),
        status: res.status(),
      });
    });

    // An unhandled alert()/confirm() blocks the page forever. Dismiss and log.
    page.on("dialog", (dialog) => {
      const accept = process.env.MCP_VISUALIZER_DIALOGS === "accept";
      this.record({
        kind: "dialog",
        type: dialog.type(),
        text: `${accept ? "accepted" : "dismissed"}: ${dialog.message()}`,
      });
      void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.lastNavSeq = this.seq;
    });

    page.on("close", () => {
      if (this.currentPage === page) {
        this.currentPage = null;
        this.cdp = null;
      }
    });
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const browser = this.browser;
    this.browser = null;
    this.currentPage = null;
    this.pwaScriptId = null;
    this.cdp = null;
    this.inflight = 0;
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already gone */
      }
    }
  }

  /** Full reset — drops cookies, storage, emulation and the event log. */
  async reset(): Promise<void> {
    await this.close();
    this.events = [];
    this.seq = 0;
    this.lastNavSeq = 0;
    this.emulation = DEFAULT_EMULATION();
  }

  // --- Emulation -----------------------------------------------------------

  async setEmulation(patch: Partial<EmulationState>): Promise<void> {
    this.emulation = { ...this.emulation, ...patch };
    if (this.isOpen()) await this.applyEmulation();
  }

  static device(name: string): Device | undefined {
    return (KnownDevices as unknown as Record<string, Device>)[name];
  }

  static deviceNames(): string[] {
    return Object.keys(KnownDevices as unknown as Record<string, Device>);
  }

  /**
   * One long-lived CDP session per page. Detaching a session drops the
   * emulation overrides it set, so safe-area insets must not be sent from a
   * throwaway session.
   */
  private async withCdp<T>(fn: (cdp: CDPSession) => Promise<T>): Promise<T | null> {
    const page = this.currentPage;
    if (!page) return null;
    try {
      if (!this.cdp) this.cdp = await page.createCDPSession();
      return await fn(this.cdp);
    } catch {
      return null;
    }
  }

  private async applyEmulation(): Promise<void> {
    const page = this.currentPage;
    if (!page) return;
    const state = this.emulation;

    const device = state.device ? VisualizerSession.device(state.device) : undefined;
    if (device) {
      // `state.viewport` deliberately keeps the configured desktop size, so
      // clearing the device later restores it instead of the phone's.
      await page.emulate(device);
    } else {
      await page.setUserAgent(this.defaultUserAgent);
      await page.setViewport(state.viewport);
    }

    // page.emulateMediaFeatures() rejects display-mode, so go straight to CDP.
    const features = [
      { name: "prefers-color-scheme", value: state.dark ? "dark" : "light" },
      {
        name: "prefers-reduced-motion",
        value: state.reducedMotion ? "reduce" : "no-preference",
      },
    ];
    if (state.pwa) features.push({ name: "display-mode", value: "standalone" });
    await this.withCdp((cdp) =>
      cdp.send("Emulation.setEmulatedMedia", { media: "screen", features }),
    );

    await this.applySafeArea();
    await this.applyPwaScript();
  }

  /**
   * Real `env(safe-area-inset-*)` emulation via CDP, so the page's own layout
   * responds instead of us guessing at its class names.
   */
  private async applySafeArea(): Promise<void> {
    const insets = this.emulation.safeArea ?? (this.emulation.pwa ? IPHONE_SAFE_AREA : null);
    // Not present in every Chromium build; withCdp swallows the failure and
    // the overlay still shows where the insets would sit.
    await this.withCdp((cdp) =>
      cdp.send(
        "Emulation.setSafeAreaInsetsOverride" as never,
        {
          insets: insets ? { ...insets } : {},
        } as never,
      ),
    );
  }

  private async applyPwaScript(): Promise<void> {
    const page = this.currentPage;
    if (!page) return;

    if (this.pwaScriptId) {
      await page.removeScriptToEvaluateOnNewDocument(this.pwaScriptId).catch(() => {});
      this.pwaScriptId = null;
    }
    if (!this.emulation.pwa) {
      await page.evaluate(removePwaOverlay).catch(() => {});
      return;
    }

    const insets = this.emulation.safeArea ?? IPHONE_SAFE_AREA;
    const overlay = this.emulation.pwaOverlay;
    const script = await page.evaluateOnNewDocument(installPwaShim, {
      insets,
      overlay,
    });
    this.pwaScriptId = script?.identifier ?? null;
    // The current document predates the shim, so apply it directly too.
    await page.evaluate(installPwaShim, { insets, overlay }).catch(() => {});
  }

  // --- Navigation ----------------------------------------------------------

  async navigate(
    url: string,
    opts: {
      waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
      timeout?: number;
      waitFor?: string;
      settleMs?: number;
    } = {},
  ): Promise<void> {
    const page = await this.page();
    try {
      await page.goto(url, {
        waitUntil: opts.waitUntil ?? "domcontentloaded",
        timeout: opts.timeout ?? NAV_TIMEOUT,
      });
    } catch (err) {
      throw new Error(describeNavError(err as Error, url));
    }
    await this.settleAfterAction(opts.waitFor, opts.settleMs);
  }

  /** Park on a blank page so emulation changes don't re-run the current app. */
  async blank(): Promise<void> {
    const page = await this.page();
    if (page.url() === "about:blank") return;
    await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  async reload(opts: { waitFor?: string; settleMs?: number } = {}): Promise<void> {
    const page = await this.page();
    await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await this.settleAfterAction(opts.waitFor, opts.settleMs);
  }

  /** `text=Some copy` waits for body text; anything else is a CSS selector. */
  async waitFor(spec: string, timeout = 10_000): Promise<void> {
    const page = await this.page();
    if (spec.startsWith("text=")) {
      const needle = spec.slice(5);
      await page.waitForFunction(
        (t: string) => (document.body?.innerText || "").includes(t),
        { timeout },
        needle,
      );
      return;
    }
    await page.waitForSelector(spec, { timeout, visible: true });
  }

  async settleAfterAction(waitFor?: string, settleMs?: number): Promise<void> {
    if (waitFor) {
      await this.waitFor(waitFor);
      return;
    }
    await this.waitForNetworkQuiet(settleMs);
  }

  /**
   * Waits for a quiet window with no in-flight requests, then gives up. Unlike
   * `networkidle0` this can never hang on a socket or a polling endpoint.
   */
  async waitForNetworkQuiet(quietMs = 400, timeout = SETTLE_TIMEOUT): Promise<boolean> {
    const start = Date.now();
    let quietSince = this.inflight === 0 ? Date.now() : 0;
    while (Date.now() - start < timeout) {
      if (this.inflight === 0) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= quietMs) return true;
      } else {
        quietSince = 0;
      }
      await sleep(50);
    }
    return false;
  }
}

function describeNavError(err: Error, url: string): string {
  const msg = err.message || String(err);
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(msg)) {
    return `Nothing is listening at ${url}. Start your dev server, or point the call at the right target with \`base_url\`/\`port\` (or MCP_DEV_SERVER_URL).`;
  }
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) {
    return `Host for ${url} could not be resolved. Check the URL.`;
  }
  if (/ERR_CERT|ERR_SSL/.test(msg)) {
    return `TLS error loading ${url}: ${msg}`;
  }
  if (/Navigation timeout|TimeoutError/i.test(msg)) {
    return `Timed out loading ${url}. The server may be compiling, or the page never fired its load event — retry, or pass a shorter \`wait_until\`.`;
  }
  return `Failed to load ${url}: ${msg}`;
}

// --- Page-side shims (serialized into the browser) -------------------------

function installPwaShim(arg: {
  insets: { top: number; bottom: number; left: number; right: number };
  overlay: boolean;
}): void {
  const apply = () => {
    try {
      Object.defineProperty(window.navigator, "standalone", {
        get: () => true,
        configurable: true,
      });
    } catch {
      /* already defined */
    }

    const existing = document.querySelector("style[data-pwa-simulation]");
    if (existing) existing.remove();
    if (!arg.overlay || !document.head) return;

    const style = document.createElement("style");
    style.setAttribute("data-pwa-simulation", "true");
    style.textContent = `
      body::before, body::after {
        content: '';
        position: fixed;
        left: 0; right: 0;
        z-index: 2147483647;
        pointer-events: none;
        background: rgba(255, 100, 0, 0.12);
      }
      body::before { top: 0; height: ${arg.insets.top}px; }
      body::after  { bottom: 0; height: ${arg.insets.bottom}px; }
    `;
    document.head.appendChild(style);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
}

function removePwaOverlay(): void {
  document.querySelector("style[data-pwa-simulation]")?.remove();
}

export const session = new VisualizerSession();
export { VisualizerSession };
