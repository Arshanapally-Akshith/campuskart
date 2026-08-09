import type { ListingDetailResponse } from '@campuskart/shared';
import { useEffect, useState } from 'react';
import { getErrorCode, getErrorMessage } from '../lib/apiError';
import { cancelReservation, confirmSale, reserveListing } from '../lib/listingsApi';

function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${seconds.toString().padStart(2, '0')}`;
}

interface ReservationPanelProps {
  listing: ListingDetailResponse;
  currentUserId: string;
  /** Re-fetches the listing from the server after any state-changing action
   * (success or 409) — `sellerPhone` visibility and `reservedBy` depend on
   * who won, which only the server knows. */
  onRefresh: () => void;
}

/**
 * BUILD.md Phase 5: countdown timer on reserved items, disabled reserve
 * button with reason, toast on 409 with live status refresh.
 */
export function ReservationPanel({ listing, currentUserId, onRefresh }: ReservationPanelProps) {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (listing.status !== 'RESERVED') return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [listing.status]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(null);
    }, 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  const isOwner = listing.sellerId === currentUserId;
  const isReservedByMe = listing.status === 'RESERVED' && listing.reservedBy === currentUserId;
  const expiresAtMs = listing.reservationExpiresAt
    ? new Date(listing.reservationExpiresAt).getTime()
    : null;
  const reservationLooksActive =
    listing.status === 'RESERVED' && expiresAtMs !== null && expiresAtMs > now;

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await action();
      onRefresh();
    } catch (err) {
      if (getErrorCode(err) === 'LISTING_UNAVAILABLE') {
        setToast('Someone else reserved this just before you — refreshing.');
        onRefresh();
      } else {
        setToast(getErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function handleReserve(): void {
    void runAction(() => reserveListing(listing.id));
  }

  function handleCancel(): void {
    void runAction(() => cancelReservation(listing.id));
  }

  function handleConfirmSale(): void {
    const buyerId = listing.reservedBy;
    if (!buyerId) return;
    void runAction(() => confirmSale(listing.id, buyerId));
  }

  const toastEl = toast && (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
      {toast}
    </div>
  );

  if (listing.status === 'SOLD') {
    return (
      <div className="flex flex-col gap-2 border-t border-slate-200 pt-3">
        {toastEl}
        <p className="text-sm text-slate-500">
          {listing.soldTo === currentUserId ? 'You bought this item.' : 'This item has been sold.'}
        </p>
      </div>
    );
  }

  if (listing.status === 'RESERVED') {
    const countdown = expiresAtMs !== null ? formatCountdown(expiresAtMs - now) : '0:00';

    return (
      <div className="flex flex-col gap-2 border-t border-slate-200 pt-3">
        {toastEl}
        <p className="text-sm font-medium text-blue-700">
          {reservationLooksActive
            ? `Reserved · expires in ${countdown}`
            : 'Reservation expired — awaiting release'}
        </p>

        {listing.sellerPhone && (
          <p className="text-sm text-slate-700">
            Seller phone: <span className="font-medium">{listing.sellerPhone}</span>
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {isOwner && (
            <button
              type="button"
              onClick={handleConfirmSale}
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Confirm sale
            </button>
          )}
          {(isOwner || isReservedByMe) && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={busy}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
            >
              Cancel reservation
            </button>
          )}
          {!isOwner && !isReservedByMe && (
            <button
              type="button"
              disabled
              title="Reserved by another buyer"
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-400"
            >
              Reserved by another buyer
            </button>
          )}
        </div>
      </div>
    );
  }

  if (listing.status === 'ACTIVE' && !isOwner) {
    return (
      <div className="flex flex-col gap-2 border-t border-slate-200 pt-3">
        {toastEl}
        <button
          type="button"
          onClick={handleReserve}
          disabled={busy}
          className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Reserving…' : 'Reserve'}
        </button>
      </div>
    );
  }

  return toastEl ? <div className="border-t border-slate-200 pt-3">{toastEl}</div> : null;
}
