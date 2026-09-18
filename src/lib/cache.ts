import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A small disk cache for the two upstream services this depends on. Both are
 * public goods run by other people — OneMap by the Land Authority, Overpass by
 * volunteers — and both rate-limit hard, so the polite thing and the fast thing
 * are the same thing: ask once, keep the answer.
 */
const CACHE_ROOT = path.join(process.cwd(), ".cache");

export async function readCache<T>(namespace: string, key: string, ttlMs: number): Promise<T | null> {
  try {
    const file = await readFile(cachePath(namespace, key), "utf8");
    const { at, body } = JSON.parse(file) as { at: number; body: T };
    if (Date.now() - at > ttlMs) return null;
    return body;
  } catch {
    return null;
  }
}

export async function writeCache(namespace: string, key: string, body: unknown) {
  try {
    await mkdir(path.join(CACHE_ROOT, namespace), { recursive: true });
    await writeFile(cachePath(namespace, key), JSON.stringify({ at: Date.now(), body }));
  } catch {
    // A cold cache costs a few seconds; it is never worth failing the request.
  }
}

function cachePath(namespace: string, key: string) {
  return path.join(CACHE_ROOT, namespace, `${createHash("sha1").update(key).digest("hex")}.json`);
}
