#!/usr/bin/env node

import { createDispatcher, rpcError } from "./protocol.mjs";
import { callTool, tools } from "./tools.mjs";

const dispatch = createDispatcher({ tools, callTool });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      send(rpcError(null, -32700, error instanceof Error ? error.message : String(error)));
      return;
    }
    void dispatch(message).then((response) => {
      if (response) send(response);
    });
  });
});
