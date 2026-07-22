import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function newNonce(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}
