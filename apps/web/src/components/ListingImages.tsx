import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_LISTING,
  type AllowedImageMimeType,
  type Listing,
} from '@campuskart/shared';
import { useRef, useState } from 'react';
import { getErrorMessage } from '../lib/apiError';
import {
  attachImage,
  removeImage,
  reorderImages,
  signUpload,
  uploadToCloudinary,
} from '../lib/uploadsApi';

interface UploadTask {
  id: string;
  fileName: string;
  progress: number;
  status: 'uploading' | 'attaching' | 'error';
  error?: string;
}

function isAllowedMimeType(type: string): type is AllowedImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

interface ListingImagesProps {
  listing: Listing;
  isOwner: boolean;
  onListingChanged: (updated: Listing) => void;
}

export function ListingImages({ listing, isOwner, onListingChanged }: ListingImagesProps) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busyPublicId, setBusyPublicId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const slotsLeft = MAX_IMAGES_PER_LISTING - listing.images.length - tasks.length;
  const canAdd = isOwner && slotsLeft > 0;

  function updateTask(id: string, patch: Partial<UploadTask>): void {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function dismissTask(id: string): void {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  async function uploadOne(file: File): Promise<void> {
    const id = `${file.name}-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;

    if (!isAllowedMimeType(file.type)) {
      setTasks((prev) => [
        ...prev,
        { id, fileName: file.name, progress: 0, status: 'error', error: 'Unsupported file type' },
      ]);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setTasks((prev) => [
        ...prev,
        { id, fileName: file.name, progress: 0, status: 'error', error: 'File is over 5 MB' },
      ]);
      return;
    }

    setTasks((prev) => [...prev, { id, fileName: file.name, progress: 0, status: 'uploading' }]);

    try {
      const sign = await signUpload(listing.id, file.type);
      const uploaded = await uploadToCloudinary(file, sign, (percent) => {
        updateTask(id, { progress: percent });
      });
      updateTask(id, { status: 'attaching', progress: 100 });
      const updated = await attachImage(listing.id, uploaded);
      onListingChanged(updated);
      dismissTask(id);
    } catch (err) {
      updateTask(id, { status: 'error', error: getErrorMessage(err) });
    }
  }

  function handleFiles(fileList: FileList | null): void {
    if (!fileList) return;
    const files = Array.from(fileList).slice(0, Math.max(0, slotsLeft));
    for (const file of files) {
      void uploadOne(file);
    }
  }

  async function handleDelete(publicId: string): Promise<void> {
    setBusyPublicId(publicId);
    try {
      onListingChanged(await removeImage(listing.id, publicId));
    } finally {
      setBusyPublicId(null);
    }
  }

  async function handleMove(index: number, direction: -1 | 1): Promise<void> {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= listing.images.length) return;

    const order = listing.images.map((img) => img.publicId);
    const [moved] = order.splice(index, 1);
    if (!moved) return;
    order.splice(targetIndex, 0, moved);

    setBusyPublicId(listing.images[index]?.publicId ?? null);
    try {
      onListingChanged(await reorderImages(listing.id, order));
    } finally {
      setBusyPublicId(null);
    }
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        {listing.images.map((image, index) => (
          <div
            key={image.publicId}
            className="relative aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
          >
            {image.thumbUrl ? (
              <img
                src={image.thumbUrl}
                alt={`Listing photo ${String(index + 1)}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <div
                className="flex h-full w-full animate-pulse flex-col items-center justify-center gap-1 bg-slate-200 text-xs text-slate-500"
                role="status"
                aria-label="Thumbnail processing"
              >
                <span>Processing…</span>
              </div>
            )}

            {isOwner && (
              <div className="absolute inset-x-0 bottom-0 flex justify-between gap-1 bg-black/50 p-1">
                <button
                  type="button"
                  onClick={() => void handleMove(index, -1)}
                  disabled={index === 0 || busyPublicId !== null}
                  className="rounded bg-white/90 px-1 text-xs disabled:opacity-40"
                  aria-label="Move image earlier"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => void handleMove(index, 1)}
                  disabled={index === listing.images.length - 1 || busyPublicId !== null}
                  className="rounded bg-white/90 px-1 text-xs disabled:opacity-40"
                  aria-label="Move image later"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(image.publicId)}
                  disabled={busyPublicId !== null}
                  className="rounded bg-white/90 px-1 text-xs text-red-700 disabled:opacity-40"
                  aria-label="Delete image"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}

        {tasks.map((task) => (
          <div
            key={task.id}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-2 text-center text-xs"
          >
            {task.status === 'error' ? (
              <>
                <span className="text-red-600">{task.error}</span>
                <button
                  type="button"
                  onClick={() => {
                    dismissTask(task.id);
                  }}
                  className="text-slate-500 underline"
                >
                  Dismiss
                </button>
              </>
            ) : (
              <>
                <span className="truncate text-slate-500">{task.fileName}</span>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full bg-slate-900 transition-all"
                    style={{ width: `${String(task.progress)}%` }}
                  />
                </div>
                <span className="text-slate-400">
                  {task.status === 'uploading' ? `${String(task.progress)}%` : 'Saving…'}
                </span>
              </>
            )}
          </div>
        ))}
      </div>

      {canAdd && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => {
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-4 text-sm text-slate-500 ${
            dragOver ? 'border-slate-500 bg-slate-50' : 'border-slate-300'
          }`}
        >
          <span>Drag photos here, or click to browse</span>
          <span className="text-xs text-slate-400">
            JPEG/PNG/WebP, up to 5 MB, {String(slotsLeft)} left
          </span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      )}
    </div>
  );
}
