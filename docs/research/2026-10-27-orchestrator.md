# Research: Orchestrator điều phối công việc cá nhân

> Ngày: 2026-10-27 · Trạng thái: research, chưa build · Áp dụng đầu tiên cho: sticker-studio

## 1. Mục tiêu

Khi launch sticker-studio và nhiều project khác, khó tự track hết bugs, reviews, analytics, feature.
Cần một **hệ thống điều phối đơn giản** chạy local trên máy 24/7:

- Cron định kỳ check nguồn việc → phân loại → điều phối.
- Việc quan trọng / có risk → hỏi tôi qua Telegram (kèm context đầy đủ).
- Fix bug, feature mới → agent tự brainstorm, tự quyết, tự làm tới PR, không hỏi.
- Notion làm project management: tôi note việc lên Notion, nhận thông báo qua Telegram.

**Không phải** một hệ agent phức tạp. Orchestrator chỉ: xác định việc → giao cho `claude` CLI hoặc
`codex` CLI → theo dõi → báo. Phần khó (đọc code, fix, test, mở PR) do CLI tự xử lý.
Cổng kiểm soát là **PR + approval của tôi**.

## 2. Nguồn cảm hứng

Video IndyDevDan — https://www.youtube.com/watch?v=52JX83rGPLc (đọc qua tóm tắt của Gemini):

- **In the loop**: người ngồi prompt từng bước.
- **Near the loop**: agent chạy theo trigger, người chỉ duyệt quyết định quan trọng. ← **mức nhắm tới**
- **Out the loop**: hoàn toàn tự động. Không nhắm tới cho solo dev (merge/release luôn do tôi).
- Trigger thay vì prompt: cron, webhook, log stream, ticket.

## 3. Kiến trúc v1

```
cron (mỗi 15–30') ──► lấy việc mới (Notion / crash / reviews / analytics)
                      ► gate (Codex, rẻ) phân loại: bỏ qua | tự làm | cần confirm trước
                      ► "cần confirm" → hỏi Telegram trước khi giao
                      ► giao: tạo git worktree → claude -p / codex exec → lưu session_id
process thoát ──────► đọc .agent/status.json
                        done        → báo Telegram + link PR
                        needs_input → hỏi Telegram (nút bấm = options)
                        không có file / lỗi → báo "agent kẹt" + log cuối
tôi reply Telegram ─► tra session_id → resume với câu trả lời → lặp lại
không trả lời sau X giờ ► nhắc lại; KHÔNG bao giờ tự chọn phương án rủi ro
21:00 ──────────────► digest ngày + retro → Telegram
```

Thành phần: ~2 script (cron dispatcher + Telegram bot), 1 bảng trạng thái (SQLite hoặc Notion),
1 template prompt giao việc. Chạy trên Mac mini / máy bàn cắm điện (laptop gập là sleep).
sticker-studio là app iOS → cần Xcode → chạy local hợp lý hơn cloud.

### Model routing

- **Codex = gate**: phân loại, rẻ. Output **bắt buộc là JSON enum**
  (`ignore | create_task | fix_bug | ping_human`, kèm `confidence`), code đọc rồi quyết định — gate không tự gọi tool.
  Confidence thấp → đẩy lên Claude hoặc hỏi tôi.
- **Claude = việc quan trọng/khó**.
- Gì tính được bằng code (crash rate tăng > X%) thì để code tính, không dùng LLM.

## 4. Vấn đề cốt lõi: biết khi nào agent dừng để hỏi + trả lời vào đúng session

Ở chế độ headless (`claude -p`, `codex exec`) agent **không đứng chờ giữa chừng** — hết lượt thì process thoát.
→ Process thoát = điểm dừng. Câu hỏi chỉ còn là: dừng vì xong hay vì cần hỏi?

### 4.1 Status file bắt buộc

Thêm vào prompt giao việc:

```
Khi kết thúc lượt, LUÔN ghi file .agent/status.json:
{
  "status": "done" | "needs_input" | "blocked",
  "summary": "đã làm gì",
  "pr_url": "...",
  "question": "...",
  "context": "bối cảnh đủ để người đọc quyết định mà không cần mở code",
  "options": [{"label": "...", "tradeoff": "..."}],
  "recommendation": "...",
  "risk": "low" | "medium" | "high"
}
```

`context`, `options`, `recommendation` là bắt buộc khi `needs_input` → đảm bảo "hỏi phải đủ context".
Thiếu thì orchestrator bắt agent chạy lại.

### 4.2 Resume theo session id

```bash
# Claude: lần đầu, lấy session_id từ output JSON
claude -p "<prompt giao việc>" --output-format json
# → {"session_id": "abc-123", "result": "...", ...}

# Khi tôi trả lời
claude -p --resume abc-123 "Trả lời của chủ: chọn phương án B. Tiếp tục."

# Codex: session id lấy từ event stream của `codex exec --json`
codex exec resume <SESSION_ID> "Trả lời của chủ: chọn phương án B."
```

Bảng ánh xạ:

| task_id | project | agent | session_id | telegram_msg_id | status |
|---|---|---|---|---|---|

Reply vào tin nhắn câu hỏi (hoặc bấm nút) → `telegram_msg_id` → `session_id` → `--resume`.

Thay thế: Claude Code Channels (đẩy tin Telegram vào session đang chạy). Nhưng resume đơn giản hơn,
dùng chung cho cả Codex, hợp mô hình cron → **chọn resume**.

## 5. Chính sách tự làm vs hỏi

- **Prompt**: "Fix bug, feature: tự brainstorm, tự chọn phương án, làm luôn. Dừng hỏi (`needs_input`) khi đụng:
  xóa/migrate dữ liệu, thanh toán, auth, đổi UX lớn, dependency lớn, đăng nội dung public, release."
- **Chặn cứng** bằng deny rules trong `.claude/settings.json` của project: `git push --force`, push lên `main`,
  `fastlane deliver` / submit store... Prompt chỉ là lời dặn, permission mới là enforcement.
- Không bao giờ auto-merge, không bao giờ tự release.

### Khi nào ping tôi (luật cố định, không để LLM "cảm nhận")

- **Ping ngay**: crash spike, app bị reject, nhiều review 1 sao cùng một lỗi, agent kẹt / cần quyền.
- **Gom vào digest**: PR sẵn sàng, task xong, số liệu ngày.
- **Không báo**: còn lại.

## 6. Bảo mật

- Prompt injection **chưa được giải quyết** — model mới chống tốt hơn nhưng không 100%. Phòng bằng kiến trúc.
- Review App Store, feedback TestFlight, email = text của người lạ. Tách vai:
  - **Triage**: đọc dữ liệu ngoài, read-only, chỉ được tạo task.
  - **Fix**: chỉ đọc task đã được tóm tắt, chạy trong worktree riêng, không có key production,
    không push `main`, không submit store.
- Gate là model rẻ (dễ bị lừa hơn) → output giới hạn enum, bị lừa thì cũng chỉ chọn sai nhánh.

## 7. Tự học (bản đơn giản)

"Bộ nhớ" đã có chỗ sẵn: `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` trong mỗi project (CLI tự đọc mỗi lần chạy),
cộng một file `orchestrator/notes.md`.

1. **Sau mỗi task**: agent ghi 3–5 dòng vào `.agent/retro/<task-id>.md` (làm gì, vướng gì, hướng dẫn nào sẽ giúp nhanh hơn).
2. **Mỗi tối**: `claude -p` đọc retro trong ngày + phản hồi của tôi (PR merge/reject, comment) →
   vấn đề lặp lại thì sửa `CLAUDE.md` / thêm-sửa skill **dưới dạng PR** → gửi digest.
3. **Tôi duyệt PR** như PR code. Code hay kiến thức đều đi qua cùng một cổng.

Nguyên tắc:

- Chỉ học từ **kết quả công việc + phản hồi của tôi**, không học từ text người lạ
  (nếu không, một injection sẽ thành skill tồn tại vĩnh viễn).
- Luật của orchestrator (phân loại, ping, quyền) agent chỉ được đề xuất, không tự sửa rồi merge.
- Những lần tôi sửa lại (reject PR, phân loại lại) là tín hiệu học giá trị nhất → lưu hết.

### Để sau (khi cần)

- Bộ eval "golden cases" tự lớn từ lịch sử thật → cho phép agent tự áp dụng skill chỉ-đọc mà không qua PR.
- Auto-revert skill nếu tỉ lệ fail/reject tăng.
- Dọn skill hàng tháng (gộp trùng, xóa không dùng).

## 8. Framework: pi-durable — chưa cần

https://github.com/earendil-works/pi/tree/main/packages/durable

- Harness TypeScript cho agent bền vững: commit mọi model turn / tool call / state xuống storage
  (SQLite, JSONL...) trước khi chạy tiếp; chết thì `resume()` từ checkpoint. Có task state machine,
  `sleepUntil` lưu trong storage, `restartLimit` (park task sau N crash), `requestId` idempotent.
- Lưu ý: **experimental** (API đổi không báo); gọi model qua API key (pi-ai), còn claude/codex CLI dùng subscription
  phải bọc thành tool; chưa có primitive chờ duyệt riêng; mỗi storage chỉ 1 process sở hữu.
- **Kết luận**: với mô hình điều phối (job ngắn, CLI tự xử lý), cron + bảng trạng thái là đủ "durable".
  Cân nhắc khi: workflow dài nhiều bước cần chạy tiếp từ giữa, nhiều agent song song cần phối hợp,
  hoặc thấy mình tự viết lại retry/resume/timeout.
  Nếu dùng: skills/memory vẫn để là file trong git, không nằm trong storage của pi.

## 9. Nguồn dữ liệu cho sticker-studio (cần kiểm tra lại khi build)

- App Store Connect API: reviews, TestFlight feedback, sales.
- Google Play Developer API: reviews; Play Developer Reporting API: Android vitals.
- Crashlytics hoặc Sentry: crash.
- Analytics: tuỳ stack.
- Notion: database `Tasks` (project, type, status, link PR, log).
- Telegram bot: thông báo + trả lời câu hỏi.

## 10. Lộ trình

1. **Read-only digest**: lấy dữ liệu hằng ngày → Telegram. Chưa đụng code.
2. **Notion làm queue**: task "Ready" → agent fix → PR → Telegram. Thêm status file + resume.
3. **Retro hằng ngày** + PR cải thiện `CLAUDE.md`/skills.
4. Mở rộng: content marketing, feature mới, project khác.

Giới hạn usage: `claude -p` headless nhiều lần/ngày ăn vào limit → đặt trần N task/ngày.

## 11. Câu hỏi mở

- Viết orchestrator bằng Node/TypeScript hay Python?
- Bảng trạng thái: SQLite local hay Notion?
- Crash: Crashlytics hay Sentry (xem stack sticker-studio)?
- Timeout chờ trả lời bao lâu thì nhắc lại?
