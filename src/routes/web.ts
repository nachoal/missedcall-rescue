import { access, readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { FastifyInstance } from "fastify";

export type WebRoutesOptions = {
  rootDir?: string;
};

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

export async function registerWebRoutes(
  app: FastifyInstance,
  options: WebRoutesOptions = {},
): Promise<void> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const webRoot = resolve(rootDir, "web");

  app.get("/", async (_request, reply) => {
    const body = await readWebFile(webRoot, "index.html", { replacePhoneToken: true });
    return reply.type(MIME_TYPES[".html"]).send(body);
  });

  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
    const asset = request.params["*"];
    if (!isSafeNestedAsset(asset)) {
      return reply.code(404).send({ ok: false, error: "Not found." });
    }

    try {
      const body = await readWebFile(webRoot, `assets/${asset}`, { binary: true });
      return reply.type(mimeTypeFor(asset)).send(body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ ok: false, error: "Not found." });
      }
      throw error;
    }
  });

  app.get<{ Params: { asset: string } }>("/:asset", async (request, reply) => {
    const asset = request.params.asset;
    if (!isSafeTopLevelAsset(asset)) {
      return reply.code(404).send({ ok: false, error: "Not found." });
    }

    try {
      const body = await readWebFile(webRoot, asset, { replacePhoneToken: asset === "index.html" });
      return reply.type(mimeTypeFor(asset)).send(body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ ok: false, error: "Not found." });
      }
      throw error;
    }
  });
}

type ReadWebFileOptions = {
  binary?: boolean;
  replacePhoneToken?: boolean;
};

async function readWebFile(
  webRoot: string,
  asset: string,
  options: ReadWebFileOptions = {},
): Promise<Buffer | string> {
  const path = resolveWebPath(webRoot, asset);

  await access(path);
  if (options.binary) {
    return readFile(path);
  }

  const body = await readFile(path, "utf8");
  if (!options.replacePhoneToken) {
    return body;
  }

  return body.replaceAll("{{PHONE_NUMBER}}", escapeHtml(process.env.PUBLIC_PHONE_NUMBER ?? ""));
}

function resolveWebPath(webRoot: string, asset: string): string {
  const path = resolve(webRoot, asset);
  const relativePath = relative(webRoot, path);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw Object.assign(new Error("Not found."), { code: "ENOENT" });
  }
  return path;
}

function isSafeTopLevelAsset(asset: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(asset) && asset !== "proof.template.html";
}

function isSafeNestedAsset(asset: string): boolean {
  return asset.length > 0 && !asset.includes("\0");
}

function mimeTypeFor(asset: string): string {
  return MIME_TYPES[extname(asset).toLowerCase()] ?? "application/octet-stream";
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
