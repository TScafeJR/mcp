# @tscafejr/mcp

MCP servers I use across projects distributed as a single npm package with one bin per server.

## Installation (consumers)

Wire up **one bin per project**, not the whole package — a project gets only the
servers it actually needs. The invocation is `npx -y <package> <bin>`:

```json
// .mcp.json in the project that needs a browser
{
  "mcpServers": {
    "visualizer": {
      "command": "npx",
      "args": ["-y", "@tscafejr/mcp", "mcp-visualizer"],
      "env": { "MCP_DEV_SERVER_PORT": "5173" }
    }
  }
}
```

```json
// .mcp.json in the project that needs a database
{
  "mcpServers": {
    "db": {
      "command": "npx",
      "args": ["-y", "@tscafejr/mcp", "mcp-db"],
      "env": { "MCP_DB_URL": "sqlite:./data/app.db" }
    }
  }
}
```

`npx <package> <name>` works because the package ships a bin called `mcp` —
npm derives the command from the unscoped package name, so a multi-bin package
without one fails with *"could not determine executable to run"*. That `mcp` bin
is a dispatcher: it takes the server name and hands off. The explicit
`npx -y -p @tscafejr/mcp mcp-db` form works too and does not depend on it.

Both bins ship in one package, so `npx` installs all of its dependencies
regardless of which bin you run — including puppeteer, which downloads Chromium.
In a project that only wants `mcp-db`, add `"PUPPETEER_SKIP_DOWNLOAD": "1"` to
that server's `env` to skip it.

## Available servers

| Bin              | Source                      | Description                                                                                                                                     |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp-visualizer` | `src/servers/visualizer.ts` | Drives a real browser against a running web app: navigate, inspect, click, type, screenshot, diagnose and visually diff. Framework-agnostic — Vite, Next.js, CRA, Netlify dev, deploy previews, anything that serves HTTP. |
| `mcp-db`         | `src/servers/db.ts`         | Read-only SQL against SQLite or Postgres: schema introspection, queries, query plans, and migration drift. Writes are impossible by construction. |
| `mcp`            | `src/servers/mcp.ts`        | Dispatcher, not a server. Exists so `npx <package> <name>` resolves — see [Troubleshooting](#troubleshooting). |

**Requirements:** Node 18+ generally; `mcp-db`'s SQLite support needs Node 22.5+
for the built-in `node:sqlite` module.

---

## `mcp-visualizer`

### How it works

One Chromium instance stays alive across tool calls, so **cookies, localStorage,
scroll position and emulation settings persist**. You can log in once and keep
working, and you only pay browser startup on the first call. The session closes
itself after five idle minutes, or immediately on `browser_close`.

Two things make the tools cheap to use:

- **`browser_snapshot` before you interact.** It returns a text outline of the
  page — controls, headings, landmarks — each tagged with a `[ref=eN]`. Pass that
  ref to `browser_click` / `browser_type` instead of guessing a CSS selector from
  a screenshot. It costs a fraction of an image.
- **Screenshots are capped.** Output is downscaled to `max_width` (default
  1000px) and viewport-only unless you ask for `full_page`. Targeting a
  `selector` captures just that element, which is usually all you need.

Console errors, uncaught exceptions and 4xx/5xx responses are recorded
continuously and appended to **every** tool result, so a screenshot of a blank
page tells you *why* it is blank.

### Target resolution

Highest precedence to lowest:

1. Per-call `url` — absolute, wins outright.
2. Per-call `base_url` — e.g. `https://preview-123.netlify.app`.
3. Per-call `port` — localhost shorthand.
4. `MCP_DEV_SERVER_URL` env — full base URL.
5. `MCP_DEV_SERVER_HOST` + `MCP_DEV_SERVER_PORT` env.
6. `http://localhost:3000`.

A call with no target at all acts on the page already open.

### Environment

| Variable                       | Default                  | Purpose                                                        |
| ------------------------------ | ------------------------ | -------------------------------------------------------------- |
| `MCP_DEV_SERVER_URL`           | —                        | Full base URL.                                                  |
| `MCP_DEV_SERVER_HOST`          | `localhost`              | Host used with `MCP_DEV_SERVER_PORT`.                           |
| `MCP_DEV_SERVER_PORT`          | —                        | Port on that host.                                              |
| `MCP_DEV_SERVER_HEADERS`       | —                        | JSON object of extra request headers (preview bypass tokens).   |
| `MCP_DEV_SERVER_BASIC_AUTH`    | —                        | `user:pass` for password-protected deploy previews.             |
| `MCP_VISUALIZER_IDLE_MS`       | `300000`                 | Idle time before the browser closes itself.                     |
| `MCP_VISUALIZER_WIDTH/HEIGHT`  | `1280` / `800`           | Default desktop viewport.                                       |
| `MCP_VISUALIZER_MAX_WIDTH`     | `1000`                   | Default screenshot width cap.                                   |
| `MCP_VISUALIZER_MAX_HEIGHT`    | `4000`                   | Default cap for `full_page` captures.                           |
| `MCP_VISUALIZER_BASELINE_DIR`  | `./.visualizer-baselines`| Where `browser_diff` stores baselines.                          |
| `MCP_VISUALIZER_HEADFUL`       | —                        | `1` to watch the browser drive itself.                          |
| `MCP_VISUALIZER_DIALOGS`       | `dismiss`                | `accept` to accept `alert()` / `confirm()` instead.             |
| `MCP_VISUALIZER_LEGACY_TOOLS`  | —                        | `0` to hide the three legacy tool names.                        |

Example client configs:

```json
// Vite project
{ "mcpServers": { "visualizer": {
  "command": "npx", "args": ["-y", "@tscafejr/mcp", "mcp-visualizer"],
  "env": { "MCP_DEV_SERVER_PORT": "5173" }
}}}

// Netlify dev
{ "mcpServers": { "visualizer": {
  "command": "npx", "args": ["-y", "@tscafejr/mcp", "mcp-visualizer"],
  "env": { "MCP_DEV_SERVER_PORT": "8888" }
}}}

// Password-protected deploy preview
{ "mcpServers": { "visualizer": {
  "command": "npx", "args": ["-y", "@tscafejr/mcp", "mcp-visualizer"],
  "env": {
    "MCP_DEV_SERVER_URL": "https://preview-123.example.com",
    "MCP_DEV_SERVER_BASIC_AUTH": "preview:hunter2"
  }
}}}
```

### Tools

**Look**

| Tool                 | Notes                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `browser_navigate`   | Open a route. Also carries emulation: `width`/`height`, `device`, `dark`, `reduced_motion`, `pwa`, `safe_area`. Called with only emulation options it reconfigures the open page. |
| `browser_snapshot`   | Text outline with `[ref=eN]` handles. `mode: full` adds body text; `root` scopes to a subtree.            |
| `browser_screenshot` | Viewport by default. `selector`/`ref` clips to one element; `full_page`, `max_width`, `format`, `quality`. |
| `browser_responsive` | The same page at several widths in one call (default 375 / 768 / 1280).                                   |
| `browser_diff`       | Compare against a saved baseline; reports changed pixel count, percentage, bounding box and a diff image. |

**Act**

| Tool             | Notes                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `browser_click`  | `action: click \| double \| right \| hover`.                                     |
| `browser_type`   | `clear` to replace the value, `submit` to press Enter, `delay` for debounced inputs. |
| `browser_press`  | Keys and chords — `Enter`, `Escape`, `Meta+K`.                                   |
| `browser_scroll` | `to: top \| bottom`, a `dy` offset, or scroll an element into view.              |
| `browser_select` | Choose `<select>` options by value.                                              |

Every action tool takes `ref` / `selector` / `find_text` to target an element,
`wait_for` (a selector, or `text=Some copy`) to wait afterwards, and optional
`screenshot` / `snapshot` flags to return the result.

**Diagnose**

| Tool                  | Notes                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `browser_eval`        | Run JS in the page and get JSON back. Assert app state without spending a screenshot.       |
| `browser_diagnostics` | Console errors/warnings, exceptions, failed and 4xx/5xx requests. `since: navigation \| session`. |
| `browser_close`       | Drop the session — cookies, storage and emulation with it.                                  |

`screenshot_page`, `type_into_element` and `inspect_network_errors` still work as
one-shot wrappers over the same engine. Set `MCP_VISUALIZER_LEGACY_TOOLS=0` to
hide them.

### PWA and safe areas

`pwa: true` emulates an iOS standalone install: `display-mode: standalone`,
`navigator.standalone`, an iPhone viewport, and **real `env(safe-area-inset-*)`
values** via Chrome DevTools Protocol — your own layout responds to them, no
class-name assumptions. Override the numbers with `safe_area: { top, bottom }`,
and turn off the tinted guide bars with `pwa_overlay: false`.

### Visual baselines

`browser_diff` stores PNGs in `.visualizer-baselines/` under the working
directory. Commit them if you want regressions caught across machines; ignore
the directory if you only use it locally within a session.

The comparison is pixel-exact, so a baseline is only meaningful against the same
capture settings — keep `max_width`, `full_page` and viewport identical between
runs, or re-record with `update: true`.

---

## `mcp-db`

Read-only access to a project's database, so schema questions get answered from
the database rather than guessed from the code. SQLite and Postgres.

### It cannot write

Two independent layers, both verified:

1. **The connection is read-only.** SQLite is opened with `readOnly: true`;
   every Postgres statement runs inside a `BEGIN READ ONLY` transaction that is
   rolled back afterwards. `DELETE`, `UPDATE`, `CREATE` and `DROP` all fail at
   the engine — *"cannot execute DELETE in a read-only transaction"*.
2. **A statement gate in front of it.** Only `SELECT`, `WITH`, `EXPLAIN`,
   `SHOW`, `TABLE` and `VALUES` are accepted, chained statements are refused,
   and a data-modifying CTE — `WITH x AS (DELETE ... RETURNING ...)`, which
   legitimately starts with `WITH` — is caught by keyword scan after comments
   and string literals are stripped.

The gate exists for clear error messages; the engine is the actual guarantee.

### Configuration

| Variable                   | Default              | Purpose                                                   |
| -------------------------- | -------------------- | ---------------------------------------------------------- |
| `MCP_DB_URL`               | *(required)*         | `postgresql://…`, `sqlite:./path.db`, or a path to a file. |
| `MCP_DB_MIGRATIONS_DIR`    | auto-detected        | Overrides migration directory discovery.                    |
| `MCP_DB_MAX_ROWS`          | `50`                 | Default row cap for `db_query`.                             |
| `MCP_DB_MAX_CHARS`         | `8000`               | Output cap per result.                                      |
| `MCP_DB_MAX_CELL`          | `60`                 | Per-cell truncation width.                                  |
| `MCP_DB_TIMEOUT_MS`        | `10000`              | Postgres `statement_timeout`.                               |
| `MCP_DB_BUSY_TIMEOUT_MS`   | `3000`               | SQLite `busy_timeout` — how long to wait out a concurrent writer. |

`MCP_DB_URL` accepts the `sqlite:data/app.db?mode=rwc` form sqlx uses — the
query string is ignored and relative paths resolve against the server's working
directory. A leading `~` expands to your home directory, so an absolute path
need not be hardcoded. `$VAR` is deliberately **not** expanded: a Postgres
password may legitimately contain `$`, and expanding it would corrupt real
connection strings. If your MCP client supports `${VAR}` in its own config
(Claude Code does), use that instead of putting a password in the file.

The server prints what it resolved to stderr as soon as it starts, so a bad
path shows up at launch rather than on the first query. Migration directories are discovered in this order: `migrations/`,
`supabase/migrations/`, `db/migrations/`, `drizzle/`, `prisma/migrations/`.

Managed Postgres (Supabase, Neon, RDS) terminates TLS with a chain Node does not
trust by default, so non-localhost connections use `rejectUnauthorized: false`.

Pointing this at a database your app is actively writing to is fine. The
connection is read-only and holds no transaction between calls; SQLite gets a
`busy_timeout` so a concurrent writer produces a short wait rather than a
`SQLITE_BUSY` error. Under WAL, readers and writers do not block each other at
all.

### Tools

| Tool             | Notes                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `db_schema`      | No args: every table and view with row counts. `table`: columns, types, nullability, defaults, keys, indexes, foreign keys **in both directions**, and the DDL. `search`: match table and column names. |
| `db_query`       | A single read-only statement. Results are capped by wrapping the query, and one extra row is fetched so "exactly 3 rows" is distinguishable from "the first 3 of many". |
| `db_explain`     | Query plan. `analyze: true` (Postgres) executes for real timings — still inside the read-only transaction.           |
| `db_migrations`  | Migration files on disk versus what the database applied. Reports pending migrations, ones applied but **missing from disk** (you switched branches), and failures. Understands sqlx, Supabase, Drizzle and plain `schema_migrations`. |

SQLite support uses Node's built-in `node:sqlite`, so it adds no dependency, but
it needs **Node 22.5 or newer**. Postgres uses `pg`, imported lazily so a
SQLite-only project never loads it.

---

## Troubleshooting

### `npm error could not determine executable to run`

npm picks the bin for `npx <package> <args>` by stripping the scope off the
package name — `@tscafejr/mcp` becomes `mcp` — and looking for a bin with that
name. It falls back to the only bin when a package has exactly one. This package
had one bin through 0.4.0, so the short form worked; adding a second bin in 0.5.0
broke it for **both** servers.

- **On 0.5.1 or later:** nothing to do. The `mcp` dispatcher bin makes the short
  form resolve again.
- **On 0.5.0:** use the explicit package flag —
  `"args": ["-y", "-p", "@tscafejr/mcp", "mcp-visualizer"]`. This form works on
  every version and never depends on bin-name inference.

Clearing the npx cache does not help; the resolution fails before the cache is
consulted.

### `mcp-db` reports a path you did not configure

It prints what it resolved at startup:

```
mcp-db: sqlite → /Users/you/project/data/app.db
```

Relative paths resolve against the working directory the MCP client launched the
server in, which is not always the project root. A leading `~` is expanded by
the server, so `sqlite:~/code/project/data/app.db` is portable across machines
and does not rely on the client expanding anything.

### The database file does not exist yet

`mcp-db` will not create one. Run your app or your migration tool first — the
error names the absolute path it tried.

---

## Adding a new server

1. Create `src/servers/<name>.ts`. Start with a shebang so the built file is directly executable:

   ```ts
   #!/usr/bin/env node
   import { Server } from "@modelcontextprotocol/sdk/server/index.js";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   // ...
   ```

   Keep the entry thin and put the implementation in `src/<name>/`, the way
   `visualizer.ts` delegates to `src/visualizer/`. Node ESM needs real
   extensions, so import local modules as `./thing.js`.

2. Add one line to the `bin` map in `package.json`:

   ```json
   "bin": {
     "mcp": "dist/servers/mcp.js",
     "mcp-visualizer": "dist/servers/visualizer.js",
     "mcp-<name>": "dist/servers/<name>.js"
   }
   ```

3. Register it in the dispatcher's `SERVERS` map in `src/servers/mcp.ts`.
   Skipping this does not break the `npx -y -p <package> mcp-<name>` form, but
   `npx <package> mcp-<name>` will report an unknown server.

4. Build and run locally:

   ```sh
   npm run build
   npm run dev <name>     # tsx, no build step
   npm run start <name>   # runs the built dist/ output
   ```

That's it — `chmod-bins.js` reads `package.json` on every build and marks all bin outputs executable, so new entries pick up automatically.

Add the new row to the table above so consumers know what's available.

## Releasing

The `release` script prompts for the bump type (major / minor / patch), runs `npm version`, builds, publishes, and pushes the commit + tag to your git remote.

```sh
npm run release
```

Equivalent manual steps if you'd rather drive it yourself:

```sh
npm version patch          # or: minor / major — bumps, commits, tags
npm publish                # prepublishOnly rebuilds dist/
git push --follow-tags     # if/when this dir has a git remote
```
