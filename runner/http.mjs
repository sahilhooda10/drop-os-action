export async function readBoundedJson(response, maximumBytes = 65_536) {
  if (!response.body) throw new Error("response_body_missing");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error("response_too_large");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("response_encoding_invalid"); }
  try { return JSON.parse(text); }
  catch { throw new Error("response_json_invalid"); }
}

export function safeFetch(fetchImpl, timeoutMs = 15_000) {
  return async (url, init = {}) => {
    const signal = AbortSignal.timeout(timeoutMs);
    return fetchImpl(url, { ...init, signal });
  };
}
