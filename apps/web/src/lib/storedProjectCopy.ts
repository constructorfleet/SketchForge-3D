/** Serializes a pre-`.skf` stored record for repair, keeping binary fields as base64. */
export function storedRecordJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => {
    if (field instanceof ArrayBuffer) return { $base64: base64(new Uint8Array(field)) };
    if (ArrayBuffer.isView(field)) return { $base64: base64(new Uint8Array(field.buffer, field.byteOffset, field.byteLength)) };
    return field;
  });
}

function base64(bytes: Uint8Array) {
  let binary = "";
  // Chunked: spreading a large array into fromCharCode overflows the stack.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
