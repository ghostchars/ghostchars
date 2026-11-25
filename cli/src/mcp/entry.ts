/**
 * The entry point of `dist/mcp.js`.
 *
 * WHY A SEPARATE BUNDLE AT ALL. The MCP SDK plus zod is most of a megabyte of
 * JavaScript to parse. `clean` is the command an agent and a CI walk call
 * hundreds of times, and it must not pay for a server it never starts. esbuild
 * is told this file is its own entry point, not a code-split chunk, so the
 * output is self-contained and is read from disk only when somebody types
 * `ghostchars mcp`.
 *
 * The module surface is deliberately one function. `src/commands/mcp.ts`
 * dynamically imports this file and calls {@link serve}; nothing else in the
 * package may reach into it, because anything that did would drag the SDK back
 * into `dist/main.js`.
 */
export { serve, createServer, installStdoutGuard, DEFAULT_SERVE_OPTIONS } from './server.js'
export type { ServeOptions, StdoutGuard } from './server.js'
