// Copied from workflows/web/src/screens/PeopleScreen.tsx — changes: two roles, `standard | admin` (CONTRACT D5), with JFlow's wording; dropped the reviewer column and `setReviewer`, the OPEN CHECKS column and its link to the lots board, and the manager tier; explainer and dialog copy say what the two roles mean here
import { useState } from 'react';
import { api } from '../api';
import { ApiError } from '../api/client';
import type { UserType } from '../api/types';
import { useSession } from '../app/session';
import { isAdmin } from '../auth/roles';
import { Dialog, DialogBody, DialogField } from '../components/Dialog';
import { ErrorNote, InfoText, Tag } from '../components/ui';

const COLUMNS = 'minmax(max-content, 1.35fr) minmax(0, 1fr) 112px 150px';

/**
 * Two kinds of account (CONTRACT D5). STANDARD is trust-the-team: everything in the app
 * except this list. ADMIN also manages this list. The history records who did what.
 */

/** What each role means, in the words the dialogs use. Listed narrowest first. */
const ROLES: { type: UserType; label: string; what: string }[] = [
  {
    type: 'standard',
    label: 'Standard',
    what: 'Everything but this list — balances, items, schedules, scenarios and settings.',
  },
  { type: 'admin', label: 'Admin', what: 'Standard, and manages this list.' },
];

function RoleField({ value, onChange }: { value: UserType; onChange: (next: UserType) => void }) {
  return (
    <DialogField label="ROLE">
      <div role="radiogroup" aria-label="Role" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ROLES.map((role) => (
          <label
            key={role.type}
            style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 14, cursor: 'pointer' }}
          >
            <input
              type="radio"
              name="role"
              value={role.type}
              checked={value === role.type}
              onChange={() => onChange(role.type)}
              style={{ marginTop: 3 }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span>{role.label}</span>
              <span style={{ fontSize: 13, color: 'var(--dim)', lineHeight: 1.5 }}>{role.what}</span>
            </span>
          </label>
        ))}
      </div>
    </DialogField>
  );
}

export function PeopleScreen() {
  const { me, users, refreshUsers } = useSession();
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  /** The role in the add / edit dialog. Standard by default — the narrowest. */
  const [type, setType] = useState<UserType>('standard');
  /** The row being edited — rename, change role. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The address a remove is being confirmed for — removal is one click nowhere. */
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const admin = isAdmin(me);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.users.create({
        email: email.trim().toLowerCase(),
        displayName: displayName.trim() || undefined,
        type,
      });
      refreshUsers();
      setAdding(false);
      setEmail('');
      setDisplayName('');
      setType('standard');
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.users.remove(target);
      refreshUsers();
      setRemoving(null);
    } catch (e) {
      setRemoving(null);
      setError(e instanceof ApiError ? e : new ApiError(0, { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await api.users.update(editing, {
        displayName: displayName.trim() || undefined,
        type,
      });
      refreshUsers();
      setEditing(null);
    } catch (e) {
      // The last-admin guard answers 409 here — "promote someone else first" is the fix.
      setError(e instanceof ApiError ? e : new ApiError(0, { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ minWidth: 720, maxWidth: 900, gap: 16 }}>
      <div className="head-row">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div className="kicker-lg">PEOPLE</div>
          <div className="page-title">Who can use this</div>
          <InfoText className="explainer" style={{ maxWidth: 620 }}>
            Two kinds of account. Standard can do everything in the app — balances, items,
            schedules, scenarios and settings. Admins also manage this list.
          </InfoText>
        </div>
        {admin && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setEmail('');
              setDisplayName('');
              setType('standard');
              setAdding(true);
            }}
          >
            Add someone
          </button>
        )}
      </div>

      {error && <ErrorNote error={error} onRetry={() => setError(null)} />}

      <div className="card-table">
        <div className="table-head" style={{ gridTemplateColumns: COLUMNS }}>
          <div>EMAIL</div>
          <div>NAME</div>
          <div>ROLE</div>
          <div />
        </div>
        {users.map((user) => (
          <div key={user.email} className="table-row" style={{ gridTemplateColumns: COLUMNS }}>
            <div className="mono" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
              {user.email}
            </div>
            <div style={{ fontSize: 14, color: 'var(--mut)', overflowWrap: 'anywhere' }}>
              {user.displayName ?? '—'}
            </div>
            <div>
              <Tag tone={user.type === 'admin' ? 'live' : 'idle'}>{user.type.toUpperCase()}</Tag>
            </div>
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                justifyContent: 'flex-end',
                whiteSpace: 'nowrap',
              }}
            >
              {admin && (
                <button
                  type="button"
                  className="btn-quiet"
                  style={{ color: 'var(--acc)' }}
                  onClick={() => {
                    setEditing(user.email);
                    setDisplayName(user.displayName ?? '');
                    setType(user.type);
                    setError(null);
                  }}
                >
                  edit
                </button>
              )}
              {admin && user.email !== me?.email && (
                <button
                  type="button"
                  className="btn-quiet"
                  style={{ color: 'var(--fail)' }}
                  onClick={() => {
                    setError(null);
                    setRemoving(user.email);
                  }}
                >
                  remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <InfoText style={{ fontSize: 13.5, color: 'var(--dim)', lineHeight: 1.6 }}>
        An admin cannot remove their own address or demote themselves — that is the mistake that
        leaves nobody able to manage the list.
      </InfoText>

      {editing && (
        <Dialog
          kicker="PEOPLE"
          title={`Edit ${editing}`}
          confirmLabel="Save"
          busy={busy}
          onConfirm={saveEdit}
          onClose={() => setEditing(null)}
          warning={
            editing === me?.email
              ? 'Demoting yourself is refused if you are the last admin — promote someone else first.'
              : undefined
          }
        >
          <DialogField label="DISPLAY NAME">
            <input
              className="input"
              aria-label="Display name"
              style={{ width: '100%', background: 'var(--panel2)' }}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </DialogField>
          <RoleField value={type} onChange={setType} />
        </Dialog>
      )}

      {removing && (
        <Dialog
          kicker="PEOPLE"
          title={`Remove ${removing}?`}
          confirmLabel="Remove them"
          busy={busy}
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
          warning="They lose access the moment they are off the list. Everything they already did stays on the record under their address."
          warnTone="warn"
        >
          <DialogBody>Balances, items and scenarios they entered stay exactly as they are.</DialogBody>
        </Dialog>
      )}

      {adding && (
        <Dialog
          kicker="PEOPLE"
          title="Add someone"
          confirmLabel="Add them"
          confirmDisabled={!email.includes('@')}
          busy={busy}
          onConfirm={add}
          onClose={() => setAdding(false)}
          warning="They can use the app from the moment they are on the list — as much of it as their role allows. Everything they do is recorded against their address."
        >
          <DialogField label="EMAIL">
            <input
              className="input"
              style={{ width: '100%', background: 'var(--panel2)' }}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@built-form.co.uk"
            />
          </DialogField>
          <DialogField label="NAME">
            <input
              className="input"
              style={{ width: '100%', background: 'var(--panel2)' }}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </DialogField>
          <RoleField value={type} onChange={setType} />
        </Dialog>
      )}
    </div>
  );
}
