# @tscafejr/mcp

MCP servers I use across projects distributed as a single npm package with one bin per server.

## Installation (consumers)

Wire a server into any MCP client config:

```json
{
  "mcpServers": {
    "visualizer": {
      "command": "npx",
      "args": ["-y", "@tscafejr/mcp", "mcp-visualizer"]
    }
  }
}
```

## Available servers

| Bin               | Source                       | Description                                                                  |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `mcp-visualizer`  | `src/servers/visualizer.ts`  | Puppeteer-driven screenshots, typing, and network/console diagnostics. Framework-agnostic — works with Vite, Next.js, CRA, Netlify dev, deploy previews, etc. |

### `mcp-visualizer` configuration

Target URL is resolved in this order (highest to lowest):

1. Per-call `base_url` arg — full URL, e.g. `https://my-site.netlify.app` or `http://localhost:8888`.
2. Per-call `port` arg — localhost shorthand.
3. `MCP_DEV_SERVER_URL` env — full base URL.
4. `MCP_DEV_SERVER_HOST` + `MCP_DEV_SERVER_PORT` env.
5. Default: `http://localhost:3000`.

Example MCP client configs:

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

// Remote deploy preview
{ "mcpServers": { "visualizer": {
  "command": "npx", "args": ["-y", "@tscafejr/mcp", "mcp-visualizer"],
  "env": { "MCP_DEV_SERVER_URL": "https://preview-123.example.com" }
}}}
```

## Adding a new server

1. Create `src/servers/<name>.ts`. Start with a shebang so the built file is directly executable:

   ```ts
   #!/usr/bin/env node
   import { Server } from "@modelcontextprotocol/sdk/server/index.js";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   // ...
   ```

2. Add one line to the `bin` map in `package.json`:

   ```json
   "bin": {
     "mcp-visualizer": "dist/servers/visualizer.js",
     "mcp-<name>": "dist/servers/<name>.js"
   }
   ```

3. Build and run locally:

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
