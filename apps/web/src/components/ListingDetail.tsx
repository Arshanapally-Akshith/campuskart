import { formatPaise, type Listing } from '@campuskart/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { getErrorMessage } from '../lib/apiError';
import { deleteListing, getListing, publishListing } from '../lib/listingsApi';
import { ListingForm } from './ListingForm';
import { ListingImages } from './ListingImages';

function hasPendingThumbnail(listing: Listing | undefined): boolean {
  return listing?.images.some((image) => image.thumbUrl === null) ?? false;
}

interface ListingDetailProps {
  listingId: string;
  onBack: () => void;
}

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-amber-50 text-amber-800 border-amber-300',
  ACTIVE: 'bg-emerald-50 text-emerald-800 border-emerald-300',
  RESERVED: 'bg-blue-50 text-blue-800 border-blue-300',
  SOLD: 'bg-slate-100 text-slate-600 border-slate-300',
  REMOVED: 'bg-red-50 text-red-700 border-red-300',
};

export function ListingDetail({ listingId, onBack }: ListingDetailProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ['listing', listingId];
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const {
    data: listing,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey,
    queryFn: () => getListing(listingId),
    retry: false,
    // Skeleton-until-thumb-arrives: poll while the worker still has an
    // image pending, stop once every thumbnail has landed.
    refetchInterval: (query) => (hasPendingThumbnail(query.state.data) ? 1500 : false),
  });

  function applyUpdate(updated: Listing): void {
    queryClient.setQueryData(queryKey, updated);
  }

  async function handlePublish(): Promise<void> {
    setActionError(null);
    setBusy(true);
    try {
      applyUpdate(await publishListing(listingId));
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setActionError(null);
    setBusy(true);
    try {
      applyUpdate(await deleteListing(listingId));
    } catch (err) {
      setActionError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (isPending) {
    return <p className="text-sm text-slate-500">Loading listing…</p>;
  }

  if (isError) {
    return (
      <div className="flex w-full flex-col gap-3 text-center">
        <p className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-700">
          {getErrorMessage(error)}
        </p>
        <button type="button" onClick={onBack} className="text-sm text-slate-500 underline">
          Back
        </button>
      </div>
    );
  }

  const isOwner = user !== null && user.id === listing.sellerId;

  if (editing) {
    return (
      <ListingForm
        existingListing={listing}
        onCancel={() => {
          setEditing(false);
        }}
        onSaved={(saved) => {
          applyUpdate(saved);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-sm text-slate-500 underline"
      >
        ← Back
      </button>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{listing.title}</h2>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[listing.status] ?? ''}`}
        >
          {listing.status}
        </span>
      </div>

      <p className="text-xl font-bold text-slate-900">{formatPaise(listing.priceInPaise)}</p>
      <p className="text-sm text-slate-500">
        {listing.category} · {listing.condition}
      </p>
      <p className="whitespace-pre-wrap text-sm text-slate-700">{listing.description}</p>

      {(listing.images.length > 0 || isOwner) && (
        <ListingImages
          listing={listing}
          isOwner={isOwner && listing.status !== 'REMOVED'}
          onListingChanged={applyUpdate}
        />
      )}

      {Object.keys(listing.attributes).length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-slate-200 p-3 text-sm">
          {Object.entries(listing.attributes).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-slate-500">{key}</dt>
              <dd className="text-slate-800">{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {isOwner && listing.status !== 'REMOVED' && (
        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
          {listing.status === 'DRAFT' && (
            <button
              type="button"
              onClick={() => void handlePublish()}
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Publish
            </button>
          )}
          {(listing.status === 'DRAFT' || listing.status === 'ACTIVE') && (
            <>
              <button
                type="button"
                onClick={() => {
                  setEditing(true);
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {actionError && <p className="text-sm text-red-600">{actionError}</p>}
    </div>
  );
}
