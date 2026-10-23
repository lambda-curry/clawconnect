import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Pipe without accumulating a response body, cancelling its reader on disconnect. */
export async function streamResponseBody(
  body: ReadableStream<Uint8Array> | null,
  destination: Writable,
): Promise<void> {
  if (!body) {
    destination.end();
    return;
  }
  await pipeline(Readable.from(body, { objectMode: false, highWaterMark: 16 * 1024 }), destination);
}
