#!/usr/bin/env node
import { startHttpServer } from "./http.js";
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
if (!loopback && !process.env.MCP_AUTH_TOKEN && process.env.MCP_ALLOW_NO_AUTH !== "1") {
    console.error("Refusing to listen on a non-loopback host without MCP_AUTH_TOKEN (set MCP_ALLOW_NO_AUTH=1 only if a gateway authenticates for you).");
    process.exit(1);
}
const server = startHttpServer(port, host);
server.on("listening", () => {
    console.error(`MCP Streamable HTTP server listening on http://${host}:${port}/mcp`);
});
