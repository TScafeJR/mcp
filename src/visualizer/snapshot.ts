/**
 * In-page DOM/accessibility walker.
 *
 * Produces a compact, indented tree of the elements that matter — interactive
 * controls, headings, landmarks — and stamps each actionable element with a
 * stable `data-mcp-ref` so tools can act on it without guessing selectors.
 */

export const REF_ATTR = "data-mcp-ref";

export type SnapshotPayload = {
  url: string;
  title: string;
  lines: string[];
  refCount: number;
  truncated: boolean;
  error?: string;
};

export type SnapshotArgs = { mode: "interactive" | "full"; root?: string };

/** Runs inside the page. Must be fully self-contained — no outer-scope refs. */
export function collectSnapshot(opts: SnapshotArgs): SnapshotPayload {
  const REF = "data-mcp-ref";
  const MAX_LINES = 800;

  document.querySelectorAll(`[${REF}]`).forEach((el) => el.removeAttribute(REF));

  const scope: Element | null = opts.root ? document.querySelector(opts.root) : document.body;

  if (!scope) {
    return {
      url: location.href,
      title: document.title,
      lines: [],
      refCount: 0,
      truncated: false,
      error: `root selector not found: ${opts.root}`,
    };
  }

  const INTERACTIVE_ROLES = new Set([
    "link",
    "button",
    "checkbox",
    "radio",
    "slider",
    "combobox",
    "listbox",
    "textbox",
    "searchbox",
    "file",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "switch",
    "spinbutton",
    "option",
  ]);
  const STRUCTURAL_ROLES = new Set([
    "heading",
    "navigation",
    "main",
    "banner",
    "contentinfo",
    "complementary",
    "form",
    "dialog",
    "table",
    "region",
    "search",
    "alert",
    "status",
    "tablist",
    "list",
    "img",
  ]);
  const TAG_ROLES: Record<string, string> = {
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    table: "table",
    img: "img",
    dialog: "dialog",
    section: "region",
    ul: "list",
    ol: "list",
    li: "listitem",
    summary: "button",
    option: "option",
  };
  const INPUT_ROLES: Record<string, string> = {
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    submit: "button",
    button: "button",
    reset: "button",
    image: "button",
    file: "file",
    search: "searchbox",
    number: "spinbutton",
    hidden: "hidden",
  };

  const clean = (s: string | null | undefined): string => (s || "").replace(/\s+/g, " ").trim();
  const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function visible(el: Element): boolean {
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
      return false;
    }
    return el.getClientRects().length > 0;
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") {
      return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    }
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLES[t] || "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return TAG_ROLES[tag] || "generic";
  }

  function ownText(el: Element): string {
    let t = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) t += n.nodeValue || "";
    });
    return clean(t);
  }

  function labelText(el: Element): string {
    const id = (el as HTMLElement).id;
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) {
        const t = clean(lab.textContent);
        if (t) return t;
      }
    }
    const wrap = el.closest("label");
    if (wrap) {
      const t = clean(wrap.textContent);
      if (t) return t;
    }
    return "";
  }

  function nameOf(el: Element, role: string): string {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return cap(aria, 80);

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = clean(
        labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" "),
      );
      if (t) return cap(t, 80);
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "img") return cap(clean(el.getAttribute("alt")), 80);

    if (tag === "input" || tag === "textarea" || tag === "select") {
      const fromLabel = labelText(el);
      if (fromLabel) return cap(fromLabel, 80);
      const ph = clean(el.getAttribute("placeholder"));
      if (ph) return cap(ph, 80);
      return cap(clean(el.getAttribute("name")), 80);
    }

    // Landmarks wrap the whole page — their text is never a useful name.
    if (STRUCTURAL_ROLES.has(role) && role !== "heading") {
      return cap(clean(el.getAttribute("title")), 80);
    }

    const text = clean((el as HTMLElement).innerText || el.textContent);
    if (text) return cap(text, 80);
    return cap(clean(el.getAttribute("title")), 80);
  }

  function isInteractive(el: Element, role: string): boolean {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && ti !== "-1") return true;
    return false;
  }

  /** Divs-as-buttons: pointer cursor, has a name, no interactive descendant. */
  function isClickableShell(el: Element): boolean {
    if (getComputedStyle(el).cursor !== "pointer") return false;
    if (el.querySelector("a,button,input,select,textarea,[role=button],[onclick]")) {
      return false;
    }
    return clean((el as HTMLElement).innerText).length > 0;
  }

  function extrasFor(el: Element, role: string): string {
    const bits: string[] = [];
    const tag = el.tagName.toLowerCase();
    if (role === "heading") {
      const lvl = el.getAttribute("aria-level") || tag.replace("h", "");
      if (/^[1-6]$/.test(lvl)) bits.push(`level=${lvl}`);
    }
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href) bits.push(`href=${cap(href, 60)}`);
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const input = el as HTMLInputElement;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (role === "checkbox" || role === "radio") {
        bits.push(input.checked ? "checked" : "unchecked");
      } else if (type !== "password" && input.value) {
        bits.push(`value="${cap(clean(input.value), 40)}"`);
      }
      if (input.required) bits.push("required");
    }
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") {
      bits.push("disabled");
    }
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) bits.push(`expanded=${expanded}`);
    const selected = el.getAttribute("aria-selected");
    if (selected === "true") bits.push("selected");
    return bits.length ? ` ${bits.join(" ")}` : "";
  }

  const lines: string[] = [];
  let refCount = 0;
  let truncated = false;

  function walk(parent: Element, depth: number): void {
    for (const child of Array.from(parent.children)) {
      if (lines.length >= MAX_LINES) {
        truncated = true;
        return;
      }
      if (!visible(child)) continue;

      let role = roleOf(child);
      if (role === "hidden") continue;

      let actionable = isInteractive(child, role);
      if (!actionable && role === "generic" && isClickableShell(child)) {
        actionable = true;
      }
      if (actionable && role === "generic") role = "clickable";

      const structural = STRUCTURAL_ROLES.has(role) || role === "listitem";
      const textual = opts.mode === "full" && role === "generic" && ownText(child).length > 0;

      let emitted = false;
      if (actionable || structural || textual) {
        const indent = "  ".repeat(Math.min(depth, 12));
        if (textual && !actionable && !structural) {
          lines.push(`${indent}- text "${cap(ownText(child), 120)}"`);
        } else {
          const name = nameOf(child, role);
          let line = `${indent}- ${role}`;
          if (name) line += ` "${name}"`;
          if (actionable) {
            const ref = `e${++refCount}`;
            child.setAttribute(REF, ref);
            line += ` [ref=${ref}]`;
          }
          line += extrasFor(child, role);
          lines.push(line);
        }
        emitted = true;
      }

      walk(child, emitted ? depth + 1 : depth);
    }
  }

  walk(scope, 0);

  return {
    url: location.href,
    title: document.title,
    lines,
    refCount,
    truncated,
  };
}

export function formatSnapshot(payload: SnapshotPayload, maxChars: number): string {
  if (payload.error) return `Snapshot error: ${payload.error}`;

  const header = `${payload.title || "(untitled)"} — ${payload.url}`;
  let body = payload.lines.join("\n");
  let note = "";

  if (payload.truncated) {
    note += "\n\n(tree truncated at 800 nodes — pass `root` to scope the snapshot)";
  }
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    const lastNewline = body.lastIndexOf("\n");
    if (lastNewline > 0) body = body.slice(0, lastNewline);
    note += `\n\n(output truncated at ${maxChars} chars — raise \`max_chars\` or pass \`root\`)`;
  }
  if (!payload.lines.length) {
    body = "(no visible interactive or structural elements found)";
  }

  return `${header}\n${"─".repeat(Math.min(header.length, 60))}\n${body}${note}`;
}
