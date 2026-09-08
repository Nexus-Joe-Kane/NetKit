import { useState } from 'react';
import type { ReactElement } from 'react';
import { ApiClientError, api, type SessionState } from '../lib/api';
import { Alert, Label } from './ui';

/**
 * Sign-in.
 *
 * Three states in one component: password, the emailed second factor, and a
 * forced password change. Keeping them together means the transitions carry
 * no page reload and no lost context.
 */
export function Login({ onSignedIn }: { onSignedIn: (session: SessionState) => void }): ReactElement {
  const [stage, setStage] = useState<'password' | 'code'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await api.login(email, password);
      if (session.awaitingTwoFactor) {
        setStage('code');
        setNotice(`We've emailed a 6-digit code to ${session.email ?? email}.`);
      } else {
        onSignedIn(session);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.verifyCode(code));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not verify that code.');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.resendCode();
      setNotice(`A new code is on its way to ${result.email}.`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not resend the code.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__masthead">
          <img src="/brand/supportwizard-lockup.png" alt="Support Wizard" />
          <div className="sw-label" style={{ marginTop: 8, color: 'var(--sw-body)' }}>
            NetKit · Network intelligence
          </div>
        </div>

        <div className="login__body">
          {error && <Alert tone="error">{error}</Alert>}
          {notice && !error && <Alert tone="info">{notice}</Alert>}

          {stage === 'password' ? (
            <form onSubmit={submitPassword}>
              <label className="field">
                <Label>Email address</Label>
                <input
                  className="field__input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                  autoFocus
                  placeholder="you@supportwizard.net"
                />
              </label>

              <label className="field">
                <Label>Password</Label>
                <input
                  className="field__input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>

              <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          ) : (
            <form onSubmit={submitCode}>
              <label className="field">
                <Label>Six-digit code</Label>
                <input
                  className="field__input sw-mono"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  style={{ fontSize: 22, letterSpacing: '0.3em', textAlign: 'center' }}
                />
                <span className="field__hint">The code expires in 10 minutes.</span>
              </label>

              <button className="btn btn--primary btn--block" type="submit" disabled={busy || code.length !== 6}>
                {busy ? 'Checking…' : 'Verify and sign in'}
              </button>

              <div className="row row--end" style={{ marginTop: 10 }}>
                <button type="button" className="btn btn--ghost btn--small" onClick={resend} disabled={busy}>
                  Resend code
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => {
                    setStage('password');
                    setCode('');
                    setNotice(null);
                  }}
                  disabled={busy}
                >
                  Start again
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="login__foot">
          SupportWizard – a division of ClubWizard Ltd
          <br />
          26 Fitzroy Square, London W1T 6ES · help@supportwizard.net
          <br />
          <span className="sw-label" style={{ fontSize: 9 }}>SupportWizard Internal · Confidential</span>
        </div>
      </div>
    </div>
  );
}

/** Forced password change, shown when an account is flagged for it. */
export function ForcePasswordChange({ onDone }: { onDone: () => void }): ReactElement {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__masthead">
          <img src="/brand/supportwizard-lockup.png" alt="Support Wizard" />
          <div className="sw-label" style={{ marginTop: 8, color: 'var(--sw-body)' }}>
            Set your password
          </div>
        </div>

        <div className="login__body">
          <Alert tone="warn">
            Your account is using a temporary password. Choose your own before continuing.
          </Alert>
          {error && <Alert tone="error">{error}</Alert>}

          <form onSubmit={submit}>
            <label className="field">
              <Label>Current (temporary) password</Label>
              <input
                className="field__input"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
                autoFocus
              />
            </label>

            <label className="field">
              <Label>New password</Label>
              <input
                className="field__input"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                required
              />
              <span className="field__hint">
                At least 12 characters, with upper and lower case letters and a number.
              </span>
            </label>

            <label className="field">
              <Label>Confirm new password</Label>
              <input
                className="field__input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                aria-invalid={confirm.length > 0 && confirm !== next}
              />
            </label>

            <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save and continue'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
