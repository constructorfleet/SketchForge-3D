// Writes the App Store Connect private key that electron-builder notarizes
// with. `APPLE_API_KEY` is the path to write, `APPLE_API_KEY_INPUT` the secret:
// either the .p8 contents or those contents base64-encoded.
//
// This lives in a file rather than a heredoc in action.yml because a quoted
// heredoc needs its terminator at column 0 of the generated script, YAML strips
// only the block scalar's own indent, and the indented `NODE` that resulted
// killed the macOS build with "syntax error: unexpected end of file" -- so the
// 1.2.0 release shipped with no installers at all.
import { writeFileSync } from "node:fs";

const PEM_MARKER = "BEGIN PRIVATE KEY";

export function decodeNotaryKey(input) {
  const decoded = input.includes(PEM_MARKER) ? input : Buffer.from(input, "base64").toString("utf8");
  if (!decoded.includes(PEM_MARKER)) {
    throw new Error("APPLE_API_KEY must be a .p8 path, key contents, or base64-encoded key contents.");
  }
  return decoded;
}

const output = process.env.APPLE_API_KEY;
if (output) {
  writeFileSync(output, decodeNotaryKey(process.env.APPLE_API_KEY_INPUT ?? ""), { mode: 0o600 });
}
