import { useCallback, useState } from 'react';
import { ApiError } from '../api/client';

/**
 * One mutation in flight: `busy` while it runs (the Dialog refuses to close meanwhile),
 * and the refusal kept as the `ApiError` it was — a 409 carrying a business rule is shown
 * as-is, with its code and request id, never swallowed.
 *
 * `run` resolves true when the mutation succeeded, so a caller closes its dialog only then.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(async (mutation: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await mutation();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, { error: String(e) }));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}

/** Which fields have been typed in — a field's problem shows once it has been touched. */
export function useTouched<K extends string>() {
  const [touched, setTouched] = useState<Partial<Record<K, true>>>({});
  const touch = useCallback((field: K) => setTouched((t) => (t[field] ? t : { ...t, [field]: true })), []);
  const shown = useCallback(
    (field: K, error: string | undefined): string | null => (touched[field] && error ? error : null),
    [touched],
  );
  return { touch, shown };
}
