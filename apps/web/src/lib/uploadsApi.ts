import type { Listing, SignUploadResponse } from '@campuskart/shared';
import axios, { type AxiosProgressEvent } from 'axios';
import { http } from './http';

export async function signUpload(listingId: string, mimeType: string): Promise<SignUploadResponse> {
  const res = await http.post<SignUploadResponse>('/api/uploads/sign', { listingId, mimeType });
  return res.data;
}

export interface CloudinaryUploadResult {
  publicId: string;
  url: string;
  width: number;
  height: number;
}

interface CloudinaryUploadApiResponse {
  public_id: string;
  secure_url: string;
  width: number;
  height: number;
}

export async function uploadToCloudinary(
  file: File,
  sign: SignUploadResponse,
  onProgress: (percent: number) => void,
): Promise<CloudinaryUploadResult> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('api_key', sign.apiKey);
  formData.append('timestamp', String(sign.timestamp));
  formData.append('signature', sign.signature);
  formData.append('public_id', sign.publicId);
  formData.append('allowed_formats', sign.allowedFormats);

  const uploadUrl = `https://api.cloudinary.com/v1_1/${sign.cloudName}/image/upload`;

  // Deliberately a bare axios call, not the `http` instance: this goes
  // straight to Cloudinary's domain, not our API, so it must not carry our
  // Authorization header or get pulled into the 401-refresh interceptor.
  const res = await axios.post<CloudinaryUploadApiResponse>(uploadUrl, formData, {
    onUploadProgress: (event: AxiosProgressEvent) => {
      if (event.total) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    },
  });

  return {
    publicId: res.data.public_id,
    url: res.data.secure_url,
    width: res.data.width,
    height: res.data.height,
  };
}

export async function attachImage(
  listingId: string,
  image: CloudinaryUploadResult,
): Promise<Listing> {
  const res = await http.post<Listing>(`/api/listings/${listingId}/images`, {
    publicId: image.publicId,
    url: image.url,
    width: image.width,
    height: image.height,
  });
  return res.data;
}

export async function removeImage(listingId: string, publicId: string): Promise<Listing> {
  const res = await http.delete<Listing>(`/api/listings/${listingId}/images`, {
    data: { publicId },
  });
  return res.data;
}

export async function reorderImages(listingId: string, publicIds: string[]): Promise<Listing> {
  const res = await http.patch<Listing>(`/api/listings/${listingId}/images/reorder`, {
    publicIds,
  });
  return res.data;
}
