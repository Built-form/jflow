import type { ReactNode } from 'react';
import { Dialog, DialogBody } from '../../components/Dialog';
import { ErrorNote } from '../../components/ui';
import { useSubmit } from '../../app/useSubmit';

/**
 * The one confirm-then-delete dialog. Removal is never one click; a refusal (a company
 * with accounts, a category in use — CONTRACT D15) stays in the dialog, as the server
 * worded it, so the person reads why before closing it.
 */
export function RemoveDialog({
  kicker,
  title,
  children,
  warning,
  confirmLabel = 'Remove it',
  remove,
  onRemoved,
  onClose,
}: {
  kicker: string;
  title: string;
  children?: ReactNode;
  warning?: ReactNode;
  confirmLabel?: string;
  remove: () => Promise<void>;
  onRemoved: () => void;
  onClose: () => void;
}) {
  const submit = useSubmit();
  return (
    <Dialog
      kicker={kicker}
      title={title}
      confirmLabel={confirmLabel}
      busy={submit.busy}
      warning={warning}
      warnTone="warn"
      onConfirm={() =>
        void submit.run(async () => {
          await remove();
          onRemoved();
        })
      }
      onClose={onClose}
    >
      {children && <DialogBody>{children}</DialogBody>}
      {submit.error && <ErrorNote error={submit.error} />}
    </Dialog>
  );
}
