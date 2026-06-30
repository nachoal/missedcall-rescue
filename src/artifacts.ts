import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function proofDir(callId: string): string {
  return join(process.cwd(), "data", "proof", callId);
}

export async function writeArtifact(callId: string, name: string, value: unknown): Promise<string> {
  const dir = proofDir(callId);
  await mkdir(dir, { recursive: true });
  const hasKnownExtension = [".json", ".txt", ".md", ".ndjson"].some((extension) =>
    name.endsWith(extension),
  );
  const path = join(dir, hasKnownExtension ? name : `${name}.json`);
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  await writeFile(path, `${body}\n`);
  return path;
}

export async function readArtifact<T = unknown>(callId: string, name: string): Promise<T | undefined> {
  try {
    const path = join(proofDir(callId), name);
    const raw = await readFile(path, "utf8");
    if (name.endsWith(".txt")) return raw as T;
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
