import { Writable } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { streamResponseBody } from "./http-stream.ts";

describe("streamResponseBody", () => {
  it("pauses response consumption until a slow client drains", async () => {
    let produced = 0;
    let release: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++produced > 100) controller.close();
        else controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const destination = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = () => {
          destination._write = (_next, _enc, done) => done();
          callback();
        };
      },
    });
    const streaming = streamResponseBody(body, destination);
    await new Promise((resolve) => setImmediate(resolve));
    expect(produced).toBeLessThanOrEqual(4);
    expect(destination.writableLength).toBe(16 * 1024);
    release!();
    await streaming;
    expect(produced).toBe(101);
    expect(destination.writableFinished).toBe(true);
  });

  it("cancels the upstream response when a client disconnects while blocked", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const destination = new Writable({ highWaterMark: 1, write() {} });
    const streaming = streamResponseBody(body, destination);
    const rejected = expect(streaming).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    destination.destroy(new Error("client disconnected"));
    await rejected;
    expect(cancelled).toBe(true);
  });
});
