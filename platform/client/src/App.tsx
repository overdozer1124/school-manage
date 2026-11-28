import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  afterLoginPath,
  createLoginApi,
  safeReturnPath,
  type LoginApi,
  type LoginOutcome,
  type MeResult,
  type SchoolSummary,
  type UserSummary,
} from "./api";
import { PasswordForm } from "./PasswordForm";

/**
 * The login screens (Issue #129): one page under /login that walks
 * the person through the platform's login flow (Issue #5's API,
 * DESIGN-INTEGRATION 8-2-1) — sign in (Google or password), set a
 * first password when an invited person has none yet, change a
 * password an administrator set (Issue #140), choose a school when
 * there are several, and read the notice when no membership can be
 * used. The screens route by state, not by URL; the only URL input
 * is the return path and the Google callback's code/state.
 *
 * After a login the person goes back to the page they came from:
 * the return path arrives as the `return` query parameter (the
 * schedule screens attach it on a 401) or, across the Google round
 * trip that lands on a bare /login, from the value stashed in
 * sessionStorage before leaving. Only same-domain paths are ever
 * honoured (safeReturnPath).
 */

const RETURN_STORAGE_KEY = "platform-login-return";

type Phase =
  | { name: "checking" }
  | { name: "login"; error: string | null; notice: string | null }
  | { name: "notice"; message: string }
  | { name: "select"; user: UserSummary; schools: SchoolSummary[] }
  | { name: "password"; mode: "first" | "required"; destination: string }
  | { name: "signed-in"; me: MeResult };

export interface AppProps {
  api?: LoginApi;
  navigate?: (url: string) => void;
}

function googleRedirectUri(): string {
  return `${window.location.origin}/login`;
}

export function App({ api: apiProp, navigate: navigateProp }: AppProps) {
  const [api] = useState<LoginApi>(() => apiProp ?? createLoginApi());
  const [navigate] = useState<(url: string) => void>(
    () => navigateProp ?? ((url: string) => window.location.assign(url)),
  );
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  const returnPathRef = useRef<string | null>(null);
  const startedRef = useRef(false);

  function handleLoginError(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 403) {
      // The unconfirmed-membership notice: the membership is
      // invited (not yet approved), suspended, or outside its
      // enrolment period — the server folds them into one message.
      // It is a state to explain, not a form error to retry.
      setPhase({ name: "notice", message: cause.message });
      return;
    }
    setPhase({
      name: "login",
      error: cause instanceof Error ? cause.message : "ログインできませんでした",
      notice: null,
    });
  }

  async function handleOutcome(outcome: LoginOutcome) {
    if (outcome.kind === "selection") {
      setPhase({ name: "select", user: outcome.user, schools: outcome.schools });
      return;
    }
    if (outcome.kind === "password-change-required") {
      // Before any school choice (Issue #140): the password an
      // administrator set may not be used until it is changed.
      setPhase({ name: "password", mode: "required", destination: "" });
      return;
    }
    // A session was issued. An invited person's first sign-in is
    // Google and leaves them without a password; the setup belongs
    // in the flow before moving on (Issue #128). A password login
    // always has one, so this check costs it nothing.
    const destination = afterLoginPath(returnPathRef.current, outcome.school);
    try {
      const me = await api.me();
      if (me && !me.hasPassword) {
        setPhase({ name: "password", mode: "first", destination });
        return;
      }
    } catch {
      /* the session itself is what matters; move on */
    }
    navigate(destination);
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    const params = new URLSearchParams(window.location.search);
    // An explicit parameter wins; the stash is the fallback,
    // because Google returns to a bare /login and the parameter
    // does not survive the round trip.
    const returnPath =
      safeReturnPath(params.get("return")) ??
      safeReturnPath(window.sessionStorage.getItem(RETURN_STORAGE_KEY));
    returnPathRef.current = returnPath;
    window.sessionStorage.removeItem(RETURN_STORAGE_KEY);

    async function init() {
      if (params.get("error")) {
        if (!cancelled) {
          setPhase({
            name: "login",
            error: "Googleログインがキャンセルされました",
            notice: null,
          });
        }
        return;
      }
      const code = params.get("code");
      const state = params.get("state");
      if (code && state) {
        // The code is single-use and does not belong in the
        // address bar or the history; strip it before anything
        // else reads the URL.
        window.history.replaceState(null, "", window.location.pathname);
        try {
          const outcome = await api.googleCallback(code, state, googleRedirectUri());
          if (!cancelled) await handleOutcome(outcome);
        } catch (cause) {
          if (!cancelled) handleLoginError(cause);
        }
        return;
      }
      try {
        const me = await api.me();
        if (cancelled) return;
        if (!me) {
          setPhase({ name: "login", error: null, notice: null });
        } else if (!me.hasPassword) {
          setPhase({
            name: "password",
            mode: "first",
            destination: afterLoginPath(returnPath, me.school),
          });
        } else {
          setPhase({ name: "signed-in", me });
        }
      } catch {
        if (!cancelled) setPhase({ name: "login", error: null, notice: null });
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
    // The init runs once, on mount; the handlers it closes over
    // are stable for that purpose.
  }, [api]);

  async function handleLogin(email: string, password: string) {
    try {
      await handleOutcome(await api.login(email, password));
    } catch (cause) {
      handleLoginError(cause);
    }
  }

  async function handleGoogle() {
    try {
      const returnPath = returnPathRef.current;
      if (returnPath) window.sessionStorage.setItem(RETURN_STORAGE_KEY, returnPath);
      navigate(await api.googleAuthUrl(googleRedirectUri()));
    } catch (cause) {
      setPhase({
        name: "login",
        error: cause instanceof Error ? cause.message : "Googleログインを開始できませんでした",
        notice: null,
      });
    }
  }

  async function handleSelect(schoolId: string) {
    try {
      await handleOutcome(await api.selectSchool(schoolId));
    } catch (cause) {
      handleLoginError(cause);
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      /* the cookie clearing is best effort; the form is the way back in */
    }
    setPhase({ name: "login", error: null, notice: null });
  }

  if (phase.name === "checking") {
    return (
      <main>
        <section className="card">
          <p>読み込み中…</p>
        </section>
      </main>
    );
  }

  if (phase.name === "notice") {
    return (
      <main>
        <section className="card">
          <h1>ログインできませんでした</h1>
          <p role="alert">{phase.message}</p>
          <button
            type="button"
            onClick={() => setPhase({ name: "login", error: null, notice: null })}
          >
            ログイン画面に戻る
          </button>
        </section>
      </main>
    );
  }

  if (phase.name === "select") {
    return (
      <main>
        <section className="card">
          <h1>学校の選択</h1>
          <p>{phase.user.name} さんの所属する学校を選んでください。</p>
          <ul className="schools">
            {phase.schools.map((school) => (
              <li key={school.schoolId}>
                <button type="button" onClick={() => void handleSelect(school.schoolId)}>
                  {school.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>
    );
  }

  if (phase.name === "password") {
    const required = phase.mode === "required";
    return (
      <main>
        <PasswordForm
          api={api}
          heading={required ? "パスワードの変更が必要です" : "パスワードの設定"}
          description={
            required
              ? "管理者が設定したパスワードは、本人が変更するまで使えません。新しいパスワードを設定してください。"
              : "次回からメールアドレスとパスワードでもログインできるように、パスワードを設定してください。"
          }
          submitLabel={required ? "変更する" : "設定する"}
          onDone={() => {
            if (required) {
              // The restricted state authorized only the change;
              // the way back in is a fresh login with the new
              // password (Issue #140's contract).
              setPhase({
                name: "login",
                error: null,
                notice: "パスワードを変更しました。新しいパスワードでログインしてください。",
              });
            } else {
              navigate(phase.destination);
            }
          }}
          {...(required ? {} : { onSkip: () => navigate(phase.destination) })}
        />
      </main>
    );
  }

  if (phase.name === "signed-in") {
    const { me } = phase;
    return (
      <main>
        <section className="card">
          <h1>ログインしています</h1>
          <p>
            {me.user.name} さん（{me.school.name}）
          </p>
          <button
            type="button"
            onClick={() => navigate(afterLoginPath(returnPathRef.current, me.school))}
          >
            {me.school.name}の画面を開く
          </button>
          <button type="button" className="secondary" onClick={() => void handleLogout()}>
            ログアウト
          </button>
        </section>
      </main>
    );
  }

  return (
    <main>
      <LoginForm
        error={phase.error}
        notice={phase.notice}
        onLogin={handleLogin}
        onGoogle={handleGoogle}
      />
    </main>
  );
}

interface LoginFormProps {
  error: string | null;
  notice: string | null;
  onLogin: (email: string, password: string) => Promise<void>;
  onGoogle: () => Promise<void>;
}

function LoginForm({ error, notice, onLogin, onGoogle }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await onLogin(email, password);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h1>ログイン</h1>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      <form onSubmit={handleSubmit}>
        <label>
          メールアドレス
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          パスワード
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          ログイン
        </button>
      </form>
      <div className="divider">または</div>
      <button type="button" className="secondary" onClick={() => void onGoogle()} disabled={busy}>
        Googleでログイン
      </button>
    </section>
  );
}
