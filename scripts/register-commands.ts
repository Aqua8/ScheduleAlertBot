// Discord 슬래시 명령어(/오늘일정, /일정추가 등)를 서버에 등록하는 1회성 스크립트.
// 명령어 목록이나 옵션을 바꿀 때마다 다시 실행해야 반영된다.
import { registerCommands } from "../src/notifiers/discord.js";

registerCommands()
  .then(() => {
    console.log("슬래시 명령어(/오늘일정) 등록 완료. 서버에 반영까지 최대 1시간 걸릴 수 있습니다.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("명령어 등록 실패:", err);
    process.exit(1);
  });
