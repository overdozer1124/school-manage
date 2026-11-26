import { SetupError } from "../db/setup.js";
import { createSetupRunnerFromEnv } from "../db/runtime.js";

/**
 * Shared runner for the operator setup commands (Issue #127). The
 * commands run on the server with PLATFORM_DATABASE_URL set; pending
 * migrations are applied first, so a truly empty database is a valid
 * starting point. Nothing secret is ever printed: the commands create
 * no password and no token, and an unexpected error's message is
 * redacted before it reaches the terminal in case it embeds the
 * connection string.
 */

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new SetupError("引数は --名前 値 の形で指定してください");
    }
    flags.set(key.slice(2), value);
  }
  return flags;
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new SetupError(`--${name} を指定してください`);
  return value;
}

function redact(message: string): string {
  const url = process.env.PLATFORM_DATABASE_URL;
  let out = message;
  if (url) out = out.split(url).join("(接続文字列)");
  return out.replace(/postgres(ql)?:\/\/\S+/g, "(接続文字列)");
}

async function main(kind: "school" | "platform-admin"): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const runner = createSetupRunnerFromEnv();
  try {
    if (kind === "school") {
      const adminName = flags.get("admin-name");
      const plan = flags.get("plan");
      const result = await runner.setupSchool({
        slug: required(flags, "slug"),
        schoolName: required(flags, "name"),
        adminEmail: required(flags, "admin-email"),
        ...(adminName !== undefined ? { adminName } : {}),
        ...(plan !== undefined ? { plan } : {}),
      });
      console.log("学校を作成しました。");
      console.log(`  school_id: ${result.schoolId}`);
      console.log(`  slug: ${result.slug}`);
      console.log(`  名前: ${result.schoolName}`);
      console.log(`  管理者: ${result.adminEmail}（person_id: ${result.adminPersonId}）`);
      console.log(`  行事予定の契約: schedule / plan=${result.plan} / active`);
      console.log(
        "ログイン: 管理者は、登録したメールアドレスの Google アカウントで Google ログインしてください。このコマンドはパスワードを発行しません。",
      );
    } else {
      const name = flags.get("name");
      const result = await runner.setupPlatformAdmin({
        email: required(flags, "email"),
        ...(name !== undefined ? { name } : {}),
      });
      console.log("運営者を追加しました。");
      console.log(`  メール: ${result.email}（person_id: ${result.personId}）`);
    }
  } finally {
    await runner.close();
  }
}

export function runSetupCli(kind: "school" | "platform-admin"): void {
  main(kind).catch((err: unknown) => {
    if (err instanceof SetupError) {
      console.error(`エラー: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`エラー: ${redact(err.message)}`);
    } else {
      console.error("エラー: 不明なエラーが発生しました");
    }
    process.exitCode = 1;
  });
}
