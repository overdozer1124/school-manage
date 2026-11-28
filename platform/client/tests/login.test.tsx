import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import {
  ApiError,
  type LoginApi,
  type LoginOutcome,
  type MeResult,
  type SchoolSummary,
  type UserSummary,
} from "../src/api";

// The login screens (Issue #129) against a fake API口: the flow's
// steps — password login, the Google start and callback, the
// school choice, the unconfirmed-membership notice, the invited
// person's first password setup, and the change an
// administrator-set password demands (Issue #140) — are walked
// here without a server.

const user: UserSummary = { id: "p-1", name: "山田先生", email: "yamada@example.jp" };
const schoolA: SchoolSummary = { schoolId: "s-a", name: "A学校", slug: "school-a" };
const schoolB: SchoolSummary = { schoolId: "s-b", name: "B学校", slug: "school-b" };

const sessionA: LoginOutcome = { kind: "session", user, school: schoolA };
const meWithPassword: MeResult = {
  user,
  school: schoolA,
  teacherId: null,
  hasPassword: true,
};
const meNoPassword: MeResult = { ...meWithPassword, hasPassword: false };

function fakeApi(overrides: Partial<LoginApi> = {}): LoginApi {
  return {
    login: vi.fn(async () => {
      throw new Error("login is not scripted");
    }),
    googleAuthUrl: vi.fn(async () => "https://accounts.google.com/o/oauth2/v2/auth?fake=1"),
    googleCallback: vi.fn(async () => {
      throw new Error("googleCallback is not scripted");
    }),
    selectSchool: vi.fn(async () => {
      throw new Error("selectSchool is not scripted");
    }),
    setPassword: vi.fn(async () => {}),
    me: vi.fn(async () => null),
    logout: vi.fn(async () => {}),
    ...overrides,
  };
}

/**
 * The /me the flow sees after a login: the page's first probe (on
 * load, before any login) must find no session, and the check
 * after a session is issued finds the person.
 */
function meAfterLogin(me: MeResult) {
  return vi.fn().mockResolvedValueOnce(null).mockResolvedValue(me);
}

function renderApp(api: LoginApi, url = "/login") {
  window.history.pushState({}, "", url);
  const navigate = vi.fn();
  render(<App api={api} navigate={navigate} />);
  return { navigate };
}

async function fillAndSubmitLogin() {
  fireEvent.change(await screen.findByLabelText("メールアドレス"), {
    target: { value: "yamada@example.jp" },
  });
  fireEvent.change(screen.getByLabelText("パスワード"), {
    target: { value: "password-1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.pushState({}, "", "/login");
});

afterEach(cleanup);

describe("password login", () => {
  it("logs in and returns to the page the person came from", async () => {
    const api = fakeApi({
      login: vi.fn(async () => sessionA),
      me: meAfterLogin(meWithPassword),
    });
    const { navigate } = renderApp(api, "/login?return=/school-a/schedule/");
    await fillAndSubmitLogin();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/school-a/schedule/"));
    expect(api.login).toHaveBeenCalledWith("yamada@example.jp", "password-1");
  });

  it("falls back to the school's page when no return path was given", async () => {
    const api = fakeApi({
      login: vi.fn(async () => sessionA),
      me: meAfterLogin(meWithPassword),
    });
    const { navigate } = renderApp(api);
    await fillAndSubmitLogin();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/school-a/schedule/"));
  });

  it("ignores a return path that names another domain", async () => {
    const api = fakeApi({
      login: vi.fn(async () => sessionA),
      me: meAfterLogin(meWithPassword),
    });
    const { navigate } = renderApp(
      api,
      `/login?return=${encodeURIComponent("https://evil.example/phish")}`,
    );
    await fillAndSubmitLogin();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/school-a/schedule/"));
    expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining("evil.example"));
  });

  it("ignores a return path with a hidden tab before a second slash", async () => {
    // The crafted link's %09 decodes to a tab; a browser strips
    // it on navigation and would read the value as
    // "//evil.example". The login must fall back to the school's
    // own page instead.
    const api = fakeApi({
      login: vi.fn(async () => sessionA),
      me: meAfterLogin(meWithPassword),
    });
    const { navigate } = renderApp(api, "/login?return=/%09/evil.example");
    await fillAndSubmitLogin();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/school-a/schedule/"));
    expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining("evil.example"));
  });

  it("shows the server's wording for a wrong password and stays on the form", async () => {
    // The server words a wrong password and an unknown email
    // identically; the screen shows what it was given, as an
    // inline error, not the notice.
    const api = fakeApi({
      login: vi.fn(async () => {
        throw new ApiError(401, "メールアドレスまたはパスワードが正しくありません");
      }),
    });
    renderApp(api);
    await fillAndSubmitLogin();
    expect(
      await screen.findByText("メールアドレスまたはパスワードが正しくありません"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("メールアドレス")).toBeInTheDocument();
  });
});

describe("the unconfirmed-membership notice", () => {
  it("shows the notice when no membership can be used", async () => {
    // Invited (not yet approved), suspended and out-of-period
    // memberships all arrive as this one 403 message.
    const message =
      "このアカウントは学校への所属が確認されていません。学校の管理者にユーザー登録を依頼してください。生徒用の公開時間割は公開用 URL からご覧ください。";
    const api = fakeApi({
      login: vi.fn(async () => {
        throw new ApiError(403, message);
      }),
    });
    renderApp(api);
    await fillAndSubmitLogin();
    expect(
      await screen.findByRole("heading", { name: "ログインできませんでした" }),
    ).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "ログイン画面に戻る" }));
    expect(await screen.findByLabelText("メールアドレス")).toBeInTheDocument();
  });
});

describe("school selection", () => {
  it("offers the schools, then completes the login with the chosen one", async () => {
    const api = fakeApi({
      login: vi.fn(async (): Promise<LoginOutcome> => ({
        kind: "selection",
        user,
        schools: [schoolA, schoolB],
      })),
      selectSchool: vi.fn(async (): Promise<LoginOutcome> => ({
        kind: "session",
        user,
        school: schoolB,
      })),
      me: meAfterLogin({ ...meWithPassword, school: schoolB }),
    });
    const { navigate } = renderApp(api, "/login?return=/school-b/schedule/");
    await fillAndSubmitLogin();
    expect(await screen.findByRole("heading", { name: "学校の選択" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "B学校" }));
    await waitFor(() => expect(api.selectSchool).toHaveBeenCalledWith("s-b"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/school-b/schedule/"));
  });
});

describe("Google login", () => {
  it("starts by asking the API for the Google URL and going there", async () => {
    const api = fakeApi();
    const { navigate } = renderApp(api, "/login?return=/school-a/schedule/");
    fireEvent.click(await screen.findByRole("button", { name: "Googleでログイン" }));
    await waitFor(() =>
      expect(api.googleAuthUrl).toHaveBeenCalledWith(`${window.location.origin}/login`),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?fake=1"),
    );
    // The return path rides in sessionStorage across the round
    // trip: Google returns to a bare /login.
    expect(window.sessionStorage.getItem("platform-login-return")).toBe("/school-a/schedule/");
  });

  it("completes the callback and returns to the stashed page", async () => {
    window.sessionStorage.setItem("platform-login-return", "/school-a/schedule/");
    const api = fakeApi({
      googleCallback: vi.fn(async () => sessionA),
      me: vi.fn(async () => meWithPassword),
    });
    const { navigate } = renderApp(api, "/login?code=fake-code&state=fake-state");
    await waitFor(() =>
      expect(api.googleCallback).toHaveBeenCalledWith(
        "fake-code",
        "fake-state",
        `${window.location.origin}/login`,
      ),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/school-a/schedule/"));
  });
});

describe("the invited person's first password setup", () => {
  it("offers the setup after a Google sign-in that has no password yet", async () => {
    const api = fakeApi({
      googleCallback: vi.fn(async () => sessionA),
      me: vi.fn(async () => meNoPassword),
    });
    const { navigate } = renderApp(api, "/login?code=fake-code&state=fake-state");
    expect(await screen.findByRole("heading", { name: "パスワードの設定" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("新しいパスワード"), {
      target: { value: "new-password-1" },
    });
    fireEvent.change(screen.getByLabelText("新しいパスワード（確認）"), {
      target: { value: "new-password-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "設定する" }));
    await waitFor(() => expect(api.setPassword).toHaveBeenCalledWith("new-password-1"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/school-a/schedule/"));
  });

  it("lets the person skip the setup and move on", async () => {
    const api = fakeApi({
      googleCallback: vi.fn(async () => sessionA),
      me: vi.fn(async () => meNoPassword),
    });
    const { navigate } = renderApp(api, "/login?code=fake-code&state=fake-state");
    expect(await screen.findByRole("heading", { name: "パスワードの設定" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "後で設定する" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/school-a/schedule/"));
    expect(api.setPassword).not.toHaveBeenCalled();
  });
});

describe("the change an administrator-set password demands (Issue #140)", () => {
  it("shows the change form before any school choice, then returns to the login form", async () => {
    const api = fakeApi({
      login: vi.fn(async (): Promise<LoginOutcome> => ({ kind: "password-change-required", user })),
    });
    renderApp(api);
    await fillAndSubmitLogin();
    expect(
      await screen.findByRole("heading", { name: "パスワードの変更が必要です" }),
    ).toBeInTheDocument();
    // No school selection and no skipping: the change is the only
    // way forward.
    expect(screen.queryByRole("heading", { name: "学校の選択" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "後で設定する" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("新しいパスワード"), {
      target: { value: "my-own-password" },
    });
    fireEvent.change(screen.getByLabelText("新しいパスワード（確認）"), {
      target: { value: "my-own-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "変更する" }));
    await waitFor(() => expect(api.setPassword).toHaveBeenCalledWith("my-own-password"));
    expect(
      await screen.findByText("パスワードを変更しました。新しいパスワードでログインしてください。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("メールアドレス")).toBeInTheDocument();
  });
});
