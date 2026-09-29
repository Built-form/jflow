import type { ReactNode } from 'react';
import { DialogField } from './Dialog';

/**
 * A dialog field with its problem under it. The Dialog's confirm stays disabled while any
 * field is wrong; this is the line that says which one, and why, before the click.
 */
export function FormField({
  label,
  note,
  error,
  children,
}: {
  label: string;
  note?: string;
  /** Shown in the fail tone; null or undefined shows `note` instead. */
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <DialogField label={label} note={error ? undefined : note}>
      {children}
      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: 'var(--fail)', lineHeight: 1.5 }}>
          {error}
        </div>
      )}
    </DialogField>
  );
}

export const inputStyle = { width: '100%', background: 'var(--panel2)' } as const;
