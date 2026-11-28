import { useState, type FormEvent } from "react";
import { ApiError, type LoginApi } from "./api";

/**
 * The password-setting form (Issue #128's flow, Issue #140's
 * change requirement), shared by the two moments the login flow
 * asks for a password:
 * - the invited person's first setup, after their first (Google)
 *   sign-in — skippable, because the sign-in itself already proved
 *   who they are and the password only adds a second way in;
 * - the change an administrator-set password demands (Issue #140)
 *   — not skippable: until the person changes it, nothing else in
 *   the flow is offered.
 * Which moment it is arrives as props (heading, description,
 * whether onSkip exists); the form itself only knows how to set a
 * password through the API口.
 */
export interface PasswordFormProps {
  api: LoginApi;
  heading: string;
  description: string;
  submitLabel: string;
  onDone: () => void;
  /** Present only when the step may be skipped (the first setup). */
  onSkip?: () => void;
}

export function PasswordForm({
  api,
  heading,
  description,
  submitLabel,
  onDone,
  onSkip,
}: PasswordFormProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 8) {
      setError("パスワードは8文字以上で入力してください");
      return;
    }
    if (password !== confirmation) {
      setError("確認用のパスワードが一致しません");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setPassword(password);
      onDone();
    } catch (cause) {
      setError(
        cause instanceof ApiError || cause instanceof Error
          ? cause.message
          : "パスワードを設定できませんでした",
      );
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h1>{heading}</h1>
      <p>{description}</p>
      <form onSubmit={handleSubmit}>
        <label>
          新しいパスワード
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <label>
          新しいパスワード（確認）
          <input
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
          />
        </label>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
        {onSkip ? (
          <button type="button" className="secondary" onClick={onSkip} disabled={busy}>
            後で設定する
          </button>
        ) : null}
      </form>
    </section>
  );
}
