import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoragePort } from "../../ports/index.js";

function normalizeKey(relativePath: string): string {
  return relativePath.replace(/^\/+/, "").replace(/\\/g, "/");
}

/**
 * S3-backed storage with tenant prefix: `{tenantId}/repos|exports|thumbs/...`
 */
export class SaasS3StoragePort implements StoragePort {
  private readonly client: S3Client;
  private readonly localRoot: string;

  constructor(
    private readonly bucket: string,
    private readonly tenantId: string,
    localRoot: string,
    region?: string,
  ) {
    this.client = new S3Client({
      region: region ?? process.env.AWS_REGION ?? process.env.S3_REGION ?? "us-east-1",
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "1",
    });
    this.localRoot = localRoot;
  }

  private objectKey(relativePath: string): string {
    return `${this.tenantId}/${normalizeKey(relativePath)}`;
  }

  resolvePath(relativePath: string): string {
    return `s3://${this.bucket}/${this.objectKey(relativePath)}`;
  }

  private localPath(relativePath: string): string {
    return join(this.localRoot, this.tenantId, normalizeKey(relativePath));
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(relativePath) }),
      );
      return true;
    } catch {
      try {
        const { access } = await import("node:fs/promises");
        await access(this.localPath(relativePath));
        return true;
      } catch {
        return false;
      }
    }
  }

  async readText(relativePath: string): Promise<string> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(relativePath) }),
      );
      return (await out.Body?.transformToString("utf8")) ?? "";
    } catch {
      return readFile(this.localPath(relativePath), "utf8");
    }
  }

  async writeText(relativePath: string, contents: string): Promise<void> {
    const key = this.objectKey(relativePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: contents,
        ContentType: "text/plain; charset=utf-8",
      }),
    );
    const local = this.localPath(relativePath);
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, contents, "utf8");
  }
}

/** Local FS storage scoped under tenant subdirectory. */
export class TenantLocalStoragePort implements StoragePort {
  constructor(
    private readonly rootDir: string,
    private readonly tenantId: string,
  ) {}

  private fullPath(relativePath: string): string {
    return join(this.rootDir, this.tenantId, normalizeKey(relativePath));
  }

  resolvePath(relativePath: string): string {
    return this.fullPath(relativePath);
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      const { access } = await import("node:fs/promises");
      await access(this.fullPath(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async readText(relativePath: string): Promise<string> {
    return readFile(this.fullPath(relativePath), "utf8");
  }

  async writeText(relativePath: string, contents: string): Promise<void> {
    const full = this.fullPath(relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
}
