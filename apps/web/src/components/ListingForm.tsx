import { zodResolver } from '@hookform/resolvers/zod';
import {
  attributesSchemaByCategory,
  CATEGORIES,
  CONDITIONS,
  createListingSchema,
  listingTextFieldsSchema,
  updateListingSchema,
  type Category,
  type Listing,
  type ListingTextFieldsInput,
} from '@campuskart/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { getErrorMessage } from '../lib/apiError';
import { createListing, updateListing } from '../lib/listingsApi';

interface AttributeFieldDef {
  name: string;
  label: string;
  type: 'text' | 'number';
  required: boolean;
}

const ATTRIBUTE_FIELDS: Record<Category, AttributeFieldDef[]> = {
  ELECTRONICS: [
    { name: 'brand', label: 'Brand', type: 'text', required: true },
    { name: 'model', label: 'Model', type: 'text', required: false },
    { name: 'warrantyMonths', label: 'Warranty (months)', type: 'number', required: false },
  ],
  BOOKS: [
    { name: 'author', label: 'Author', type: 'text', required: true },
    { name: 'edition', label: 'Edition', type: 'text', required: false },
    { name: 'isbn', label: 'ISBN', type: 'text', required: false },
  ],
  CYCLE: [
    { name: 'gearCount', label: 'Gear count', type: 'number', required: true },
    { name: 'brand', label: 'Brand', type: 'text', required: false },
    { name: 'frameSize', label: 'Frame size', type: 'text', required: false },
  ],
  FURNITURE: [
    { name: 'material', label: 'Material', type: 'text', required: true },
    { name: 'dimensions', label: 'Dimensions', type: 'text', required: false },
  ],
  LAB: [
    { name: 'equipmentType', label: 'Equipment type', type: 'text', required: true },
    { name: 'brand', label: 'Brand', type: 'text', required: false },
  ],
  OTHER: [],
};

const inputClass =
  'rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none';

interface ListingFormProps {
  /** When provided, the form edits this listing instead of creating a new one. */
  existingListing?: Listing;
  onSaved: (listing: Listing) => void;
  onCancel?: () => void;
}

export function ListingForm({ existingListing, onSaved, onCancel }: ListingFormProps) {
  const isEdit = existingListing !== undefined;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ListingTextFieldsInput>({
    resolver: zodResolver(listingTextFieldsSchema),
    defaultValues: existingListing
      ? {
          title: existingListing.title,
          description: existingListing.description,
          condition: existingListing.condition,
        }
      : { condition: 'GOOD' },
  });

  const [category, setCategory] = useState<Category>(existingListing?.category ?? 'ELECTRONICS');
  // Price is deliberately kept outside react-hook-form: the input displays
  // and edits *rupees* for the human, but the wire format is integer paise
  // (ARCHITECTURE.md §3.2) — that conversion happens once, explicitly, at
  // submit time below, rather than through a field-level transform that
  // would only run on user edits and not on the pre-filled edit default.
  const [priceInRupees, setPriceInRupees] = useState<string>(() =>
    existingListing ? (existingListing.priceInPaise / 100).toFixed(2) : '',
  );
  const [priceError, setPriceError] = useState<string | null>(null);

  const [attributeValues, setAttributeValues] = useState<Record<string, string>>(() =>
    existingListing
      ? Object.fromEntries(
          Object.entries(existingListing.attributes).map(([k, v]) => [k, String(v)]),
        )
      : {},
  );
  const [attributeError, setAttributeError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function handleCategoryChange(next: Category): void {
    setCategory(next);
    // Category is locked in edit mode, so this only ever fires in create
    // mode — clear out the previous category's attribute values so a
    // leftover e.g. `gearCount` can't be submitted alongside an
    // ELECTRONICS listing.
    setAttributeValues({});
    setAttributeError(null);
  }

  function parsePrice(): number | null {
    const rupees = Number(priceInRupees);
    if (!priceInRupees || Number.isNaN(rupees) || rupees <= 0) {
      setPriceError('Enter a price greater than ₹0');
      return null;
    }
    return Math.round(rupees * 100);
  }

  function parseAttributes(): Record<string, string | number> | null {
    const fieldDefs = ATTRIBUTE_FIELDS[category];
    const raw: Record<string, string | number> = {};
    for (const field of fieldDefs) {
      const value = attributeValues[field.name];
      if (value === undefined || value === '') continue;
      raw[field.name] = field.type === 'number' ? Number(value) : value;
    }

    const result = attributesSchemaByCategory[category].safeParse(raw);
    if (!result.success) {
      setAttributeError(result.error.issues.map((issue) => issue.message).join('; '));
      return null;
    }
    return result.data;
  }

  async function onSubmit(text: ListingTextFieldsInput): Promise<void> {
    setSubmitError(null);
    setPriceError(null);
    setAttributeError(null);

    const priceInPaise = parsePrice();
    const attributes = parseAttributes();
    if (priceInPaise === null || !attributes) return;

    try {
      if (isEdit) {
        const patch = updateListingSchema.parse({ ...text, priceInPaise, attributes });
        const saved = await updateListing(existingListing.id, patch);
        onSaved(saved);
      } else {
        // Final authoritative validation through the exact schema the API
        // uses — text fields, price, and attributes were already checked
        // individually above; this re-confirms the assembled shape before
        // it leaves the browser.
        const input = createListingSchema.parse({
          ...text,
          category,
          priceInPaise,
          attributes,
        });
        const saved = await createListing(input);
        onSaved(saved);
      }
    } catch (err) {
      setSubmitError(getErrorMessage(err));
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="flex w-full flex-col gap-3">
      <h2 className="text-lg font-semibold text-slate-900">
        {isEdit ? 'Edit listing' : 'Create a listing'}
      </h2>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        Category
        <select
          value={category}
          disabled={isEdit}
          onChange={(e) => {
            handleCategoryChange(e.target.value as Category);
          }}
          className={inputClass}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        Title
        <input type="text" {...register('title')} className={inputClass} />
        {errors.title && <span className="text-xs text-red-600">{errors.title.message}</span>}
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        Description
        <textarea rows={4} {...register('description')} className={inputClass} />
        {errors.description && (
          <span className="text-xs text-red-600">{errors.description.message}</span>
        )}
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        Price (₹)
        <input
          type="number"
          step="0.01"
          min="0"
          value={priceInRupees}
          onChange={(e) => {
            setPriceInRupees(e.target.value);
          }}
          className={inputClass}
        />
        {priceError && <span className="text-xs text-red-600">{priceError}</span>}
      </label>

      <label className="flex flex-col gap-1 text-sm text-slate-700">
        Condition
        <select {...register('condition')} className={inputClass}>
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      {ATTRIBUTE_FIELDS[category].length > 0 && (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-xs font-medium uppercase text-slate-500">
            {category} details
          </legend>
          {ATTRIBUTE_FIELDS[category].map((field) => (
            <label key={field.name} className="flex flex-col gap-1 text-sm text-slate-700">
              {field.label}
              {field.required && <span className="text-red-500"> *</span>}
              <input
                type={field.type}
                value={attributeValues[field.name] ?? ''}
                onChange={(e) => {
                  setAttributeValues((prev) => ({ ...prev, [field.name]: e.target.value }));
                }}
                className={inputClass}
              />
            </label>
          ))}
        </fieldset>
      )}
      {attributeError && <p className="text-sm text-red-600">{attributeError}</p>}
      {submitError && <p className="text-sm text-red-600">{submitError}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {isSubmitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create listing'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
