import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';

cloudinary.config({
  cloud_name: env.cloudinaryCloudName,
  api_key: env.cloudinaryApiKey,
  api_secret: env.cloudinaryApiSecret,
  secure: true,
});

/** Pure/local — Cloudinary's documented signing algorithm, no network call. */
export function signUploadParams(params: Record<string, string | number>): string {
  return cloudinary.utils.api_sign_request(params, env.cloudinaryApiSecret);
}

export async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch image from ${url}: HTTP ${String(res.status)}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function uploadThumbnail(buffer: Buffer, publicId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: publicId, overwrite: true, resource_type: 'image' },
      (err, result) => {
        if (err || !result) {
          reject(err instanceof Error ? err : new Error('Cloudinary thumbnail upload failed'));
          return;
        }
        resolve(result.secure_url);
      },
    );
    stream.end(buffer);
  });
}

export async function destroyAsset(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId);
}

export interface CloudinaryResource {
  publicId: string;
  createdAt: string;
  bytes: number;
}

export interface ResourcesPage {
  resources: CloudinaryResource[];
  nextCursor: string | null;
}

/** One page of assets under a prefix — used by the orphan-cleanup job. */
export async function listResourcesByPrefix(
  prefix: string,
  cursor: string | null,
): Promise<ResourcesPage> {
  const result = (await cloudinary.api.resources({
    type: 'upload',
    prefix,
    max_results: 500,
    ...(cursor ? { next_cursor: cursor } : {}),
  })) as {
    resources: { public_id: string; created_at: string; bytes: number }[];
    next_cursor?: string;
  };

  return {
    resources: result.resources.map((r) => ({
      publicId: r.public_id,
      createdAt: r.created_at,
      bytes: r.bytes,
    })),
    nextCursor: result.next_cursor ?? null,
  };
}

export async function destroyAssets(publicIds: string[]): Promise<void> {
  if (publicIds.length === 0) return;
  await cloudinary.api.delete_resources(publicIds);
}
