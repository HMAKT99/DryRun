#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdout is the protocol channel: never log to it.
const server = createServer();
await server.connect(new StdioServerTransport());
