// ARCHITECTURE.md §6: cursor = base64url(JSON.stringify({ c: createdAt.toISOString(), i: _id })).
export interface FeedCursor {
  c: string;
  i: string;
}

export function encodeCursor(createdAt: Date, id: string): string {
  const payload: FeedCursor = { c: createdAt.toISOString(), i: id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string): FeedCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'c' in parsed &&
      'i' in parsed &&
      typeof (parsed as Record<string, unknown>)['c'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['i'] === 'string'
    ) {
      return parsed as FeedCursor;
    }
    return null;
  } catch {
    return null;
  }
}
