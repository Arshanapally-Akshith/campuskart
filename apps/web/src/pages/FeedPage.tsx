import {
  CATEGORIES,
  CONDITIONS,
  formatPaise,
  type Category,
  type Condition,
  type ListingSummary,
} from '@campuskart/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getErrorMessage } from '../lib/apiError';
import { getFeed, type FeedParams } from '../lib/listingsApi';

const inputClass =
  'rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

function toPaise(rupees: string): number | undefined {
  if (!rupees) return undefined;
  const n = Number(rupees);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

interface SearchBoxProps {
  initialValue: string;
  onCommit: (value: string) => void;
}

/**
 * Uncontrolled-from-the-URL's-perspective search input: local draft state
 * for responsive typing, debounced commits back to the URL. Mounted with
 * `key={q}` by the parent so that external changes to `q` (browser
 * back/forward, "Clear filters") reset this component's local state by
 * remounting it — the React-recommended way to sync local state from an
 * external source, instead of a `useEffect` that calls `setState` to mirror
 * a changing prop.
 */
function SearchBox({ initialValue, onCommit }: SearchBoxProps) {
  const [draft, setDraft] = useState(initialValue);

  useEffect(() => {
    const timer = setTimeout(() => {
      onCommit(draft);
    }, 400);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, onCommit]);

  return (
    <input
      type="search"
      placeholder="Search listings…"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
      }}
      className={inputClass}
    />
  );
}

function ListingCard({ listing }: { listing: ListingSummary }) {
  const thumb = listing.images[0]?.thumbUrl ?? null;
  return (
    <Link
      to={`/listings/${listing.id}`}
      className="flex flex-col gap-1 rounded-lg border border-slate-200 p-2 transition hover:border-slate-400"
    >
      <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-slate-100">
        {thumb ? (
          <img src={thumb} alt={listing.title} className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-slate-400">No photo</span>
        )}
      </div>
      <p className="truncate text-sm font-medium text-slate-900">{listing.title}</p>
      <p className="text-sm font-bold text-slate-900">{formatPaise(listing.priceInPaise)}</p>
      <p className="text-xs text-slate-500">
        {listing.category} · {listing.condition}
      </p>
    </Link>
  );
}

export function FeedPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const category = searchParams.get('category') ?? '';
  const condition = searchParams.get('condition') ?? '';
  const seller = searchParams.get('seller') ?? '';
  const minPrice = searchParams.get('minPrice') ?? '';
  const maxPrice = searchParams.get('maxPrice') ?? '';
  const q = searchParams.get('q') ?? '';

  // Stable identity so SearchBox's debounce effect (which depends on this)
  // doesn't reset its timer on every unrelated FeedPage re-render (e.g. a
  // background react-query refetch) — only when the URL actually changes.
  const updateFilter = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) {
            next.set(key, value);
          } else {
            next.delete(key);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const commitSearch = useCallback(
    (value: string) => {
      updateFilter('q', value);
    },
    [updateFilter],
  );

  const apiParams: FeedParams = {
    category: (category as Category) || undefined,
    condition: (condition as Condition) || undefined,
    seller: seller || undefined,
    minPrice: toPaise(minPrice),
    maxPrice: toPaise(maxPrice),
    q: q || undefined,
  };
  const isSearchMode = Boolean(apiParams.q);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, status, error } = useInfiniteQuery({
    queryKey: ['feed', apiParams],
    queryFn: ({ pageParam }) =>
      isSearchMode
        ? getFeed({ ...apiParams, page: (pageParam as number | undefined) ?? 1 })
        : getFeed({ ...apiParams, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | number | undefined,
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined;
      return isSearchMode ? (lastPage.page ?? 1) + 1 : (lastPage.nextCursor ?? undefined);
    },
  });

  const listings = data?.pages.flatMap((page) => page.listings) ?? [];

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 md:w-56">
        <SearchBox key={q} initialValue={q} onCommit={commitSearch} />

        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Category
          <select
            value={category}
            onChange={(e) => {
              updateFilter('category', e.target.value);
            }}
            className={inputClass}
          >
            <option value="">Any</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Condition
          <select
            value={condition}
            onChange={(e) => {
              updateFilter('condition', e.target.value);
            }}
            className={inputClass}
          >
            <option value="">Any</option>
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Min price (₹)
          <input
            type="number"
            min="0"
            value={minPrice}
            onChange={(e) => {
              updateFilter('minPrice', e.target.value);
            }}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Max price (₹)
          <input
            type="number"
            min="0"
            value={maxPrice}
            onChange={(e) => {
              updateFilter('maxPrice', e.target.value);
            }}
            className={inputClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Seller ID
          <input
            type="text"
            value={seller}
            onChange={(e) => {
              updateFilter('seller', e.target.value);
            }}
            className={inputClass}
          />
        </label>

        <button
          type="button"
          onClick={() => {
            setSearchParams(new URLSearchParams());
          }}
          className="text-sm text-slate-500 underline"
        >
          Clear filters
        </button>
      </aside>

      <div className="flex-1">
        {status === 'pending' && <p className="text-sm text-slate-500">Loading listings…</p>}

        {status === 'error' && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-700">
            {getErrorMessage(error)}
          </div>
        )}

        {status === 'success' && listings.length === 0 && (
          <p className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            No listings match your filters.
          </p>
        )}

        {status === 'success' && listings.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {listings.map((listing) => (
                <ListingCard key={listing.id} listing={listing} />
              ))}
            </div>
            <div ref={sentinelRef} className="h-4" />
            {isFetchingNextPage && (
              <p className="py-4 text-center text-sm text-slate-500">Loading more…</p>
            )}
            {!hasNextPage && listings.length > 0 && (
              <p className="py-4 text-center text-xs text-slate-400">
                {isSearchMode ? 'End of search results.' : "That's everything."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
