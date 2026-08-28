import type { IncomingMessage } from "node:http";
import { ValidationError } from "../security/InputValidator.js";

/**
 * Reads a request body with a hard byte ceiling.
 *
 * The limit is enforced while streaming, so an oversized upload is rejected as
 * soon as it crosses the threshold rather than after being buffered - a client
 * cannot make the process hold 500MB by claiming a small Content-Length.
 */
export class PayloadTooLargeError extends ValidationError {
  constructor(limitBytes: number) {
    super(`Request body exceeds the ${limitBytes} byte limit`, "PAYLOAD_TOO_LARGE");
    this.name = "PayloadTooLargeError";
  }
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  // Trust the declared length only to reject early; never to allocate.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }

  const contentType = req.headers["content-type"];
  if (contentType && !/^application\/json\b/i.test(contentType)) {
    throw new ValidationError(`Unsupported Content-Type "${contentType}"; expected application/json`, "UNSUPPORTED_MEDIA_TYPE");
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
      if (error) reject(error);
      else resolve(value ?? "");
    };

    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > maxBytes) {
        // Stop reading immediately; the connection is closed by the server.
        req.pause();
        finish(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => finish(undefined, Buffer.concat(chunks).toString("utf8"));
    const onError = (error: Error): void => finish(error);
    const onAborted = (): void => finish(new ValidationError("Client aborted the request", "CLIENT_ABORTED"));

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}
