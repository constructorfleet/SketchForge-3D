import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { listRuntimeTools, outputPath, renderReference } from "../../scripts/generate-mcp-reference.mjs";

test("published MCP tool reference documents every runtime tool and actual input schema", async () => {
  const tools = await listRuntimeTools();
  const reference = await readFile(outputPath, "utf8");

  assert.ok(tools.length > 30, `expected the public MCP registry, got ${tools.length} tools`);
  for (const tool of tools) {
    assert.ok(reference.includes(`## ${tool.name}\n`), `missing ${tool.name}`);
    assert.ok(reference.includes(`\n${tool.description}\n`), `missing description for ${tool.name}`);
    assert.ok(reference.includes(`\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``), `missing schema for ${tool.name}`);
  }
  assert.equal(reference, renderReference(tools), "checked-in reference must be deterministic and current");
});
