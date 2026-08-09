import type {
  Category,
  Condition,
  CreateListingInput,
  FeedResponse,
  Listing,
  UpdateListingInput,
} from '@campuskart/shared';
import { http } from './http';

export interface FeedParams {
  category?: Category | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  condition?: Condition | undefined;
  seller?: string | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  page?: number | undefined;
}

export async function getFeed(params: FeedParams): Promise<FeedResponse> {
  const res = await http.get<FeedResponse>('/api/listings', { params });
  return res.data;
}

export async function createListing(input: CreateListingInput): Promise<Listing> {
  const res = await http.post<Listing>('/api/listings', input);
  return res.data;
}

export async function getListing(id: string): Promise<Listing> {
  const res = await http.get<Listing>(`/api/listings/${id}`);
  return res.data;
}

export async function updateListing(id: string, input: UpdateListingInput): Promise<Listing> {
  const res = await http.patch<Listing>(`/api/listings/${id}`, input);
  return res.data;
}

export async function publishListing(id: string): Promise<Listing> {
  const res = await http.post<Listing>(`/api/listings/${id}/publish`);
  return res.data;
}

export async function deleteListing(id: string): Promise<Listing> {
  const res = await http.delete<Listing>(`/api/listings/${id}`);
  return res.data;
}
