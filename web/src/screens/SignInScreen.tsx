// Copied from workflows/web/src/screens/SignInScreen.tsx — changes: JFlow's name and strapline; the not-configured example is the local API (JFlow's stacks are deployed in step 11); dropped `ReviewersOnlyScreen` and `NotForYouScreen` (JFlow has no role-gated screens, CONTRACT D5) and their roles/PageHeader/router imports
import { GoogleLogin } from '@react-oauth/google';
import { useState } from 'react';
import { apiBaseUrl } from '../api/client';
import { writeSharedToken } from '../auth/sharedSession';

/**
 * The first screen, whenever there is no usable credential.
 *
 * The token it obtains is the estate-wide one: `writeSharedToken` publishes it to the
 * `.built-form.co.uk` cookie every other app reads, so signing in here signs you in to
 * ShipLine, JFPRO, DispatchLine, Workflows and the rest as well — and a sign-in there
 * means this screen is skipped entirely.
 *
 * Nothing here is green. Green means settled, everywhere in this app.
 */
export function SignInScreen({
  expired,
  onSignedIn,
}: {
  /** True when a session ended rather than never existing. Different sentence, same door. */
  expired?: boolean;
  onSignedIn: (credential: string) => void;
}) {
  const [refused, setRefused] = useState<string | null>(null);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 26,
        padding: 24,
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7 }}>
        <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em' }}>JFlow</div>
        <div
          className="mono"
          style={{ fontSize: 11, letterSpacing: '.16em', color: 'var(--dim)' }}
        >
          CASHFLOW FORECAST
        </div>
      </div>

      <div
        style={{
          border: '1px solid var(--line)',
          borderRadius: 13,
          background: 'var(--panel)',
          boxShadow: 'var(--shadow)',
          padding: '26px 28px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 17,
          maxWidth: 380,
        }}
      >
        <div
          style={{
            fontSize: 14.5,
            color: 'var(--mut)',
            lineHeight: 1.6,
            textAlign: 'center',
          }}
        >
          {expired
            ? 'Your session ran out. Sign in again and you will land back where you were — nothing you recorded is lost.'
            : 'Sign in with your work Google account. The same sign-in covers every Built Form app.'}
        </div>

        <GoogleLogin
          onSuccess={(response) => {
            setRefused(null);
            const credential = response.credential;
            if (!credential) {
              setRefused('Google returned no credential. Try again.');
              return;
            }
            // Refused outright if the gateways would reject it — storing optimistically
            // would read back as "no session" a tick later and look like a dead button.
            if (!writeSharedToken(credential)) {
              setRefused('That credential is not one this system accepts. Try a different account.');
              return;
            }
            onSignedIn(credential);
          }}
          onError={() =>
            setRefused(
              'Google could not complete the sign-in. If this keeps happening, this address may not be an authorised origin for the app.',
            )
          }
          theme="outline"
          shape="pill"
        />

        {refused && (
          <div
            style={{
              borderLeft: '2px solid var(--fail)',
              background: 'var(--failBg)',
              color: 'var(--fail)',
              padding: '10px 13px',
              fontSize: 13.5,
              lineHeight: 1.55,
            }}
            role="alert"
          >
            {refused}
          </div>
        )}
      </div>

      <div className="mono" style={{ fontSize: 11, color: 'var(--dim)', letterSpacing: '.08em' }}>
        {apiBaseUrl()}
      </div>
    </div>
  );
}

/**
 * No API address. Not a failure to reach the server — a failure to have been told where it
 * is, which is a different fix and deserves different words.
 */
export function NotConfiguredScreen() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <div
        style={{
          border: '1px solid var(--line)',
          borderRadius: 13,
          background: 'var(--panel)',
          padding: '26px 28px',
          maxWidth: 560,
          display: 'flex',
          flexDirection: 'column',
          gap: 13,
        }}
      >
        <div className="mono" style={{ fontSize: 11, letterSpacing: '.14em', color: 'var(--warn)' }}>
          NOT CONFIGURED
        </div>
        <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Nobody told this build where the API is
        </div>
        <div style={{ fontSize: 14.5, color: 'var(--mut)', lineHeight: 1.65 }}>
          Neither JFlow stack is deployed yet: each URL is written into{' '}
          <span className="mono">src/config/env.ts</span> once it is, and one stack is never used
          as a stand-in for the other. For local development, set{' '}
          <span className="mono">VITE_API_BASE_URL</span> in{' '}
          <span className="mono">web/.env.local</span> and start the dev server again — Vite
          reads the file once, at startup.
        </div>
        <pre
          className="mono"
          style={{
            fontSize: 12.5,
            background: 'var(--panel2)',
            border: '1px solid var(--line)',
            borderRadius: 9,
            padding: '12px 14px',
            margin: 0,
            overflowX: 'auto',
            lineHeight: 1.7,
          }}
        >
          {'VITE_API_BASE_URL=http://localhost:5000/api/v1'}
        </pre>
        <div style={{ fontSize: 13.5, color: 'var(--dim)', lineHeight: 1.6 }}>
          A <span className="mono">localhost</span> address here also turns the sign-in gate off,
          because that server bypasses auth. Anything else asks for a Google sign-in.
        </div>
      </div>
    </div>
  );
}

/**
 * Signed in, and the server still says no: the account is not on the allowlist. A dead end
 * for the user, so it says who to ask rather than looping them back to a sign-in that
 * would succeed and be refused again. Same wording as every other built-form app's
 * "no access" page; says nothing about other apps — this screen cannot know which of
 * them the person is allowed into. Signing out is estate-wide (one cookie), and says so.
 */
export function NotAllowedScreen({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <div
        style={{
          border: '1px solid var(--line)',
          borderRadius: 13,
          background: 'var(--panel)',
          padding: '26px 28px',
          maxWidth: 460,
          display: 'flex',
          flexDirection: 'column',
          gap: 13,
        }}
      >
        <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Sorry, you do not have access to JFlow
        </div>
        <div style={{ fontSize: 14.5, color: 'var(--mut)', lineHeight: 1.65 }}>
          Speak to an admin or the IT team if you need access.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 20px' }}>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Check again
          </button>
          <button
            type="button"
            onClick={onSignOut}
            style={{
              font: 'inherit',
              fontSize: 13.5,
              fontWeight: 600,
              padding: '2px 4px',
              border: 0,
              background: 'none',
              color: 'var(--mut)',
              cursor: 'pointer',
              textDecoration: 'underline',
              textUnderlineOffset: 4,
            }}
          >
            Sign out everywhere
          </button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--dim)', lineHeight: 1.6 }}>
          Signing out here signs you out of other apps as well.
        </div>
      </div>
    </div>
  );
}
