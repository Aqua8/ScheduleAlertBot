// 최초 1회(또는 권한 범위가 바뀔 때) 실행하는 Google 로그인 스크립트.
// 로컬에 임시 HTTP 서버를 띄워 OAuth 리디렉션을 받고, 발급받은 refresh token을
// data/google-token.json에 저장한다. 이후 앱은 이 파일만 읽어서 로그인 없이 API를 호출한다.
import "dotenv/config";
import { google } from "googleapis";
import { createServer } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
// calendar.events: 캘린더 목록/설정은 못 건드리고 일정(이벤트)만 읽고 쓸 수 있는 최소 권한 범위.
// (/일정추가 명령어로 이벤트를 생성하려면 읽기 전용 권한(calendar.readonly)으로는 부족하다.)
// tasks.readonly: 오늘 마감인 할 일(Google Tasks)을 읽기 위한 권한.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks.readonly",
];

const DATA_DIR = new URL("../data/", import.meta.url);
const TOKEN_PATH = fileURLToPath(new URL("google-token.json", DATA_DIR));

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET을 .env에 먼저 설정하세요.");
    process.exit(1);
  }

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // refresh_token을 확실히 받기 위해
    scope: SCOPES,
  });

  console.log("아래 URL을 브라우저에서 열어 Google 계정으로 로그인/동의하세요:\n");
  console.log(authUrl, "\n");
  console.log(`로그인 후 자동으로 http://localhost:${PORT} 로 리디렉션됩니다. 대기 중...`);

  const code = await waitForAuthCode();
  const { tokens } = await oAuth2Client.getToken(code);

  await mkdir(fileURLToPath(DATA_DIR), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");

  console.log(`\n토큰을 저장했습니다: ${TOKEN_PATH}`);
  console.log("이제 npm run send-test -- --dry-run 으로 캘린더 연동을 확인할 수 있습니다.");
}

/** OAuth 동의 후 Google이 리디렉션해 줄 인증 코드(code)를 받기 위해 잠깐 로컬 서버를 띄운다. */
function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (error) {
        res.end(`<h1>인증 실패</h1><p>${error}</p><p>터미널로 돌아가세요.</p>`);
        server.close();
        reject(new Error(`OAuth 오류: ${error}`));
        return;
      }
      res.end("<h1>인증 완료</h1><p>이 창은 닫고 터미널로 돌아가세요.</p>");
      server.close();
      resolve(code!);
    });
    server.listen(PORT);
  });
}

main().catch((err) => {
  console.error("실패:", err);
  process.exit(1);
});
