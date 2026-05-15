/**
 * Module 6 §SEC-007 — ClamAV scan client.
 *
 * Speaks clamd's INSTREAM TCP protocol on port 3310:
 *   1. Send `zINSTREAM\0` command.
 *   2. Send N chunks framed as `<4-byte BE length><data>`.
 *   3. Send `<4-byte BE 0>` (end-of-stream sentinel).
 *   4. Read null-terminated response: `stream: OK\0` or
 *      `stream: <signature-name> FOUND\0`. Errors come as
 *      `... ERROR\0`.
 *
 * Network and protocol errors surface as `{ result: 'error', message }`
 * so the caller can keep the media row in `awaiting_scan` and retry,
 * rather than collapsing transient failures into permanent quarantine.
 */
import net from "node:net";

const CLAMAV_HOST = process.env.CLAMAV_HOST ?? "127.0.0.1";
const CLAMAV_PORT = Number(process.env.CLAMAV_PORT ?? 3310);
const CLAMAV_TIMEOUT_MS = Number(process.env.CLAMAV_TIMEOUT_MS ?? 30_000);
// clamd default StreamMaxLength is 25M; we cap our chunk so we never
// exceed it in one frame. Real upload size is capped at 20MB per spec.
const CHUNK_SIZE = 64 * 1024;

export type ScanResult =
  | { result: "clean" }
  | { result: "infected"; signature: string }
  | { result: "error"; message: string };

export async function scanBuffer(data: Buffer): Promise<ScanResult> {
  return new Promise<ScanResult>((resolve) => {
    const socket = net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
    let settled = false;
    const out: Buffer[] = [];

    const finish = (r: ScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };

    socket.setTimeout(CLAMAV_TIMEOUT_MS);
    socket.on("timeout", () => finish({ result: "error", message: "clamav_timeout" }));
    socket.on("error", (e) => finish({ result: "error", message: e.message }));
    socket.on("data", (chunk) => out.push(chunk));
    socket.on("end", () => {
      const text = Buffer.concat(out).toString("utf8").replace(/\0+$/, "").trim();
      if (text === "stream: OK") return finish({ result: "clean" });
      const m = /^stream: (.+) FOUND$/m.exec(text);
      if (m) return finish({ result: "infected", signature: m[1]!.trim() });
      if (/ERROR$/m.test(text)) {
        return finish({ result: "error", message: text });
      }
      finish({ result: "error", message: `unexpected_response: ${text.slice(0, 200)}` });
    });

    socket.on("connect", () => {
      // 1. Command.
      socket.write("zINSTREAM\0");
      // 2. Framed chunks.
      for (let i = 0; i < data.length; i += CHUNK_SIZE) {
        const slice = data.subarray(i, i + CHUNK_SIZE);
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(slice.length, 0);
        socket.write(lenBuf);
        socket.write(slice);
      }
      // 3. EOS sentinel.
      const eos = Buffer.alloc(4);
      eos.writeUInt32BE(0, 0);
      socket.write(eos);
    });
  });
}

/** Liveness probe — sends PING command, expects `PONG\0`. Used by health endpoint. */
export async function ping(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(2000);
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (chunk) => {
      const t = chunk.toString("utf8").replace(/\0+$/, "").trim();
      done(t === "PONG");
    });
  });
}
