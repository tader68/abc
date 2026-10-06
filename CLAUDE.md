# Ghi chú dự án (đọc trước khi làm tiếp)

Người dùng là người Việt, đi làm văn phòng, trade thủ công trên Binance. Luôn trả lời **bằng tiếng Việt**, ngắn gọn, nói thẳng kết quả xấu. Mục tiêu của họ: lãi đều khoảng 500$/tháng để trả nợ. App gốc (`crypto-app/`, React + Vite, deploy Vercel) do AI viết.

Nhánh làm việc: `claude/charming-fermat-jjwcz7`. Toàn bộ nghiên cứu nằm trong `crypto-app/research/` (README.md ở đó liệt kê mọi thí nghiệm và kết quả).

## Trạng thái hiện tại (10/2026)

**Bot tín hiệu đang chạy thật** trên MacBook của người dùng, ở `~/abc/crypto-app`:
- launchd (`~/Library/LaunchAgents/com.abc.signalbot.plist`) gọi `research/live/run_live.sh` mỗi 10 phút, và file này gọi `research/live/run.py`.
- `run.py` chỉ làm việc khi có nến 4h mới. Mất mạng thì ghi lỗi và tự thử lại ở lần sau. Mất quá 12 giờ thì báo một tin Telegram.
- Các bước của một lần chạy: `live_export.js` (1500 nến 4h + funding từ fapi.binance.com, cùng chỉ báo như lúc huấn luyện) → `live.py` (10 mô hình, tín hiệu, theo dõi thoát lệnh, Telegram, `state.json`, `history/runs.jsonl`).
- Môi trường Python ở `.venv/`. Config Telegram ở `research/live/config.json` (không commit; chat id đúng là id người dùng, không phải id bot).
- Người dùng vào lệnh bằng tiền thật, vốn nhỏ. Hướng dẫn sử dụng: `research/live/HUONG_DAN.md`.

**Chiến lược** (bản ổn định, chọn theo đúng quy trình):
- Khi một coin futures **rơi ≥6% so với đỉnh 24h**, lấy trung bình **10 mô hình LightGBM** (`ml_event.py`, cùng cấu hình, seed 0,3,7,20–26), mỗi mô hình cho xác suất "lệnh này thắng".
- Vào lệnh khi **xác suất ≥0.90**. Chốt lời **+4%**, giữ tối đa **48h**, thoát sớm nếu **coin trung vị rơi thêm 5%** kể từ tín hiệu. Không cắt lỗ cứng.
- Mỗi lệnh dùng **10–20% vốn** (tự tin hơn thì nhiều vốn hơn), tối đa 10 lệnh. Ưu tiên tín hiệu mạnh nhất khi hết slot.
- Backtest walk-forward: 2022–2024 khoảng +53%/năm, sụt 30%. 2025–nay khoảng +26%/năm, sụt 3.5%. Hai nhóm seed độc lập cho kết quả gần nhau.
- **Kỳ vọng thực tế: +25–30%/năm, năm xấu sụt khoảng 30%.**
- Mô hình huấn luyện đến 2026-10-02, lưu ở `research/live/models/`. Huấn luyện lại bằng `research/live/retrain.bat`, hoặc `node research/mlexport2.js` rồi `ml_event.py --seed k --final research/live/models`.

## Những điều đã kiểm chứng: đừng lặp lại

**Không có lợi thế sau phí:**
- Chỉ báo kỹ thuật cổ điển, GP và luật tiến hóa trên khoảng 240 chỉ báo.
- Xoay vòng coin, sentiment / Fear & Greed, fundamentals (DefiLlama), MVRV, pairs, BTC dẫn trước altcoin, giờ trong ngày, các setup trên mạng xã hội, tín hiệu kênh Telegram.
- Mô hình ML dự đoán hướng giá trên mọi nến (AUC 0.52).

**Đã thử và không cải thiện mô hình sự kiện:**
- Dữ liệu vĩ mô (S&P, VIX, DXY, FOMC, Wikipedia) và nguồn mới (premium index, Coinbase premium, DVOL, sổ lệnh, stablecoin): mô hình bám vào biến chậm, bị overfit theo giai đoạn.
- Nến 1h, chiều short sau khi coin bị bơm, cắt lỗ cứng, thoát khi BTC sập, giới hạn số lệnh / lệnh mới mỗi nến.
- Chia vốn theo biến động, ngưỡng theo thứ hạng, để mô hình tự chọn TP / thời gian giữ, ghép mô hình khác cấu hình.

**Có lợi thế nhỏ:**
- Funding carry BTC/ETH khoảng 3%/năm, có thể dùng cho phần vốn để không.
- Short coin mới niêm yết (giảm mạnh nhưng rủi ro bị squeeze).

## Quy tắc làm việc

- Không tin backtest nếu chưa có các bước sau:
  - walk-forward, chọn cấu hình trên 2022–2024, kiểm tra một lần trên 2025–nay;
  - placebo (xáo nhãn);
  - tăng phí ×2, ×3;
  - so nhiều seed hoặc nhiều nhóm;
  - có coin đã chết trong dữ liệu.
- Huấn luyện LightGBM **chạy lần lượt** (máy 4 nhân; chạy song song chậm đi khoảng 50 lần). Đừng `pkill -f` theo tên script, vì lệnh đó giết luôn shell đang chạy nó.
- Binance chặn (HTTP 451) từ máy chủ cloud, nên lúc đó dùng `data.binance.vision`. Trên máy người dùng ở Việt Nam, fapi hoạt động bình thường.
- `research/event_features.py` là code dùng chung giữa huấn luyện và bot. Sửa ở đó thì phải kiểm tra lại `ml_event.py` cho ra kết quả y hệt (`ev_s22`).
- Commit cuối message có dòng Co-Authored-By. Không tạo PR nếu người dùng không yêu cầu.

## Việc tiếp theo

1. **Sau 2–3 tháng chạy thật:** đọc `research/live/history/runs.jsonl` và `state.json` (người dùng gửi lên). So xác suất mô hình với tỷ lệ thắng thực tế, so với backtest (thắng khoảng 70–90%, lãi trung bình 2–3%/lệnh, khoảng 6–7 lệnh/tháng). Nếu lệch nhiều, xem lại ngưỡng hoặc huấn luyện lại.
2. **Huấn luyện lại mỗi tháng**, nếu người dùng muốn.
3. **Có thể thêm trang xem tín hiệu và kết quả trong app React** (chưa làm).
4. **Nếu lỗi trên Mac:** đọc `research/live/log.txt`, `history/runs.jsonl` (các dòng `type: fail`) và `launchctl list | grep signalbot`.
