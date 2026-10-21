# Taste Mobile · v0.1.0 (Experimental)

**Bản thử nghiệm mobile-first, lấy cảm hứng từ [Taste Skill](https://github.com/Leonxlnx/taste-skill)**, dành cho Codex, Claude Code và coding agents đọc được `SKILL.md`.

Mục tiêu: giúp agent **tìm visual direction phù hợp với *từng app*, tạo những concept thực sự khác biệt, triển khai native UI và tự xem screenshot để critique/refine**, thay vì đi theo cùng một template AI.

> Đây là skill tự viết dựa trên phương pháp của Taste Skill, không phải fork nguyên xi `draw.mjs` / `inspect.mjs` từ bản web, cũng không liên quan chính thức tới tác giả gốc. Chưa có benchmark độc lập xác nhận đạt chất lượng Apple Design Award.

## 1. Cài trong project

Giải nén ZIP để được thư mục `taste-mobile/`. Chạy từ thư mục root **của dự án**:

### Codex (khuyên dùng cho App Factory)

```bash
mkdir -p .agents/skills
cp -R /path/to/taste-mobile .agents/skills/taste-mobile
```

### Claude Code

```bash
mkdir -p .claude/skills
cp -R /path/to/taste-mobile .claude/skills/taste-mobile
```

Có thể cài cả hai. Khởi động phiên agent mới để chắc chắn skill được phát hiện.

Không cần cài Maestro, Expo, Chrome hay MCP mới. Agent sẽ dùng công cụ inspect UI sẵn có. Node.js 18+ **chỉ cần** nếu muốn dùng CLI tùy chọn để gợi ý design directions.

## 2. Dùng ngay

Prompt mẫu cho Codex:

```text
Use the taste-mobile skill for this React Native bare CLI app.

Goal: discover a distinctive, premium visual identity appropriate to this
product—not a generic AI template. First understand the actual core user job,
research real mobile product references, then explore 3 genuinely different
art directions. Render 2 connected screen concepts for each direction if tools
allow. Explain the tradeoffs and recommend one.

Once a direction is selected, implement it using the existing app stack.
Run the native app in the simulator/emulator, inspect screenshots, critique
composition/native UX/accessibility, fix the top 3 defects and re-inspect
for up to 3 rounds. Use your built-in inspection capabilities; do not install
Maestro or migrate the project to Expo.

Leave .taste-mobile/DESIGN.md and .taste-mobile/audit.md with real evidence.
Be honest about any platform or screen you could not inspect.
```

Nếu chỉ muốn **explore rồi chọn style**, dừng sau ba concept:

```text
Use taste-mobile in Explore mode for OLFUNA. Create 3 distinct directions,
render connected screen concepts, compare product fit, and stop for my choice.
Do not change production code yet.
```

Nếu muốn **audit app hiện có**:

```text
Use taste-mobile in Audit mode. Run my app, inspect the scanner + collection
screens using your existing UI tools, and report the highest-impact defects
with real screenshots. Do not edit code yet.
```

## 3. Gợi ý concept bằng CLI (optional)

```bash
node .agents/skills/taste-mobile/scripts/draw.mjs \
  --product "OLFUNA: perfume collection + continuous scanner" \
  --category collection --mood refined --options 3 \
  --out .taste-mobile/directions.md

node .agents/skills/taste-mobile/scripts/draw.mjs \
  --product "Modern Toybox: children's paper outfit sticker creator" \
  --category creation --mood playful --options 3 \
  --json
```

CLI chọn từ **12 hướng gợi ý mobile-first** và cố gắng bảo đảm sự khác biệt về bố cục/tương tác. Nó **không** tự research, render, chụp screenshot, kiểm chứng UX hoặc thay thế mắt nhìn của agent. Kết quả chỉ là nguyên liệu để agent thiết kế.

## 4. Chế độ

| Mode | Khi nào | Đầu ra |
|---|---|---|
| Explore | Tìm style/app mới | Research + 3 concept + đề xuất |
| Build | Đã chọn style | Native implementation + visual QA |
| Refine | App đang generic / thiếu polish | Before/after screenshots + sửa những vấn đề lớn |
| Audit | Chỉ review | Phân tích có bằng chứng, không sửa code |

## 5. Thư mục

```text
taste-mobile/
  SKILL.md                  # Entry point cho agent
  README.md                 # Cài và sử dụng
  NOTICE.md                 # Nguồn gốc, license upstream, giới hạn
  references/
    discovery.md            # Nghiên cứu + tìm ý tưởng thuộc về sản phẩm
    directions.md           # So sánh visual directions
    native-craft.md         # iOS/Android/RN bare, input, accessibility
    anti-slop.md            # Chống AI template nhưng không cực đoan
    motion.md               # Signature interactions + reduced motion
    visual-qa.md            # Inspect/critique/fix có bằng chứng
  templates/
    brief.md
    design-decision.md
    audit.md
  scripts/
    direction-library.json  # 12 direction families mới viết cho mobile
    draw.mjs                # CLI đề cử 3 hướng có tính tương phản
  examples/
    olfuna-direction-deal.md # Example output, not mockups
    toybox-direction-deal.md # Example output, not mockups
  tests/
    draw.test.mjs           # Tests cho CLI
```

Các file agent tạo trong project đặt tại `.taste-mobile/`, không chỉnh vào chính folder chứa skill.

## 6. Kiểm tra package

```bash
node --test taste-mobile/tests/draw.test.mjs
```

Hiện đã kiểm thử CLI bằng Node, nhưng **chưa benchmark chất lượng giao diện** trên các app thực tế. Nên chạy cùng một brief với/không có skill trên OLFUNA hoặc Modern Toybox, so screenshot và usability, rồi mới dùng rộng khắp App Factory.
