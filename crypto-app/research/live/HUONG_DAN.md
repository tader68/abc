# Bot tín hiệu "mua sau bán tháo": hướng dẫn cài trên máy tính ở nhà

Bot **không đặt lệnh hộ bạn** và **không cần API key Binance**. Sau mỗi nến 4h, bot tải giá từ Binance, chạy 10 mô hình rồi gửi Telegram cho bạn:

- 🟢 **MUA**: coin nào, bao nhiêu USDT, giá chốt lời. Bạn tự vào lệnh trên Binance.
- ✅ **Đã chạm chốt lời**: lệnh limit chốt lời của bạn đã khớp.
- ⏰ / ⚠️ **ĐÓNG LỆNH NGAY**: đã hết 2 ngày giữ lệnh, hoặc cả thị trường đang sập.
- 🤖 Mỗi sáng: bot còn chạy không, và lãi/lỗ cộng dồn của các tín hiệu.

Nến 4h đóng lúc **03:00, 07:00, 11:00, 15:00, 19:00, 23:00** (giờ Việt Nam). Bot kiểm tra **mỗi 10 phút**, nên tín hiệu thường đến trong khoảng 10 phút sau giờ đóng nến.

**Khi mất mạng hoặc máy ngủ:**
- Bot tự thử lại sau mỗi 10 phút và tự chạy bù ngay khi có mạng lại.
- Tin Telegram chưa gửi được sẽ được gửi bù.
- Tín hiệu MUA chỉ được gửi nếu nến vừa đóng **dưới 2 giờ**. Trễ hơn thì bot ghi là "bị lỡ", không bảo bạn vào lệnh trễ. Tin MUA đã quá 1 giờ mà chưa gửi được sẽ bị thay bằng thông báo "đã quá hạn, BỎ QUA".
- Mất kết nối quá 12 giờ: bot báo một tin, và báo thêm một tin khi chạy lại được.

**Nhật ký để cải tiến:**
- `research/live/log.txt`: chi tiết từng lần chạy.
- `research/live/history/runs.jsonl`: mỗi nến 4h, mọi coin đang rơi mạnh cùng xác suất mô hình chấm, tín hiệu, lệnh đóng, và cả các lần lỗi.
- `research/live/state.json`: toàn bộ tín hiệu và kết quả, kể cả tín hiệu bị lỡ.

## Dùng Mac? Làm theo phần này thay cho bước 1, 3 và 4 bên dưới

1. Mở **Terminal** (Cmd + Space, gõ `Terminal`). Cài **Homebrew** (trình cài phần mềm cho Mac):
   ```
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
   Cài xong, nó in ra mục **"Next steps"** gồm 2 lệnh `echo ... >> ~/.zprofile` và `eval ...`. Copy và chạy đúng 2 lệnh đó.
2. Cài Node, Python, Git và thư viện cần cho LightGBM:
   ```
   brew install node python git libomp
   ```
3. Tải bot về **thư mục nhà** (đừng để trong Documents hay Desktop, vì macOS chặn chương trình chạy tự động đọc các thư mục đó):
   ```
   cd ~
   git clone https://github.com/tader68/abc.git
   cd abc/crypto-app
   git checkout claude/charming-fermat-jjwcz7
   ```
4. Làm **bước 2 (Telegram)** bên dưới. File cấu hình nằm ở `~/abc/crypto-app/research/live/config.json`. Tạo file: `cp research/live/config.example.json research/live/config.json` rồi `open -e research/live/config.json`.
5. Cài môi trường Python và cho bot tự chạy (kiểm tra mỗi 10 phút). Sau mỗi lần cập nhật bot bằng `git pull`, chạy lại lệnh này:
   ```
   sh research/live/install_mac.sh
   ```
6. Chạy thử ngay:
   ```
   node research/live_export.js
   .venv/bin/python research/live.py
   ```
   Dòng cuối của lệnh đầu phải ghi **"cách đây dưới 4 giờ"**.
7. Không cho Mac ngủ: **System Settings → Battery (hoặc Energy) → Options → bật "Prevent automatic sleeping on power adapter when the display is off"**, và cắm sạc. MacBook **gập màn hình sẽ ngủ**: khi đó bot không chạy. Lúc Mac thức dậy, bot chạy bù để theo dõi lệnh, nhưng tín hiệu mua lúc ngủ sẽ bị lỡ.

Trên Mac, mọi lệnh `python research\live.py ...` trong hướng dẫn này đổi thành `.venv/bin/python research/live.py ...` (dấu `/` thay cho `\`), chạy trong thư mục `~/abc/crypto-app`.

## Xem bot mà không cần gõ lệnh

- **Trên máy tính:** nhấp đúp file **`Bot tín hiệu.html`** trên Desktop. Trang hiển thị:
  - bot có đang chạy không;
  - lệnh đang mở, lãi/lỗ hiện tại và còn bao lâu tới hạn;
  - tổng lãi, lãi theo tháng, đường vốn;
  - "radar" các coin đang bị bán tháo và xác suất mô hình chấm.

  Bot tự cập nhật trang mỗi 10 phút, trang tự làm mới mỗi 5 phút. Muốn xem nhanh hơn, có thể kéo vào thanh Bookmark của trình duyệt. Lối tắt được tạo khi chạy `install_mac.sh` (Windows: mở `research\live\dashboard.html`).
- **Trên điện thoại:** nhắn cho bot Telegram:
  - **/baocao**: tổng lãi/lỗ;
  - **/lenh**: các lệnh đang mở;
  - **/trangthai**: bot có đang chạy không.

  Bot trả lời trong vòng 10 phút, hoặc bấm nút Menu trong khung chat để chọn lệnh.

## 1. Cài phần mềm (làm một lần)

1. **Node.js** bản LTS (22 trở lên): https://nodejs.org → tải bản Windows → Next liên tục.
2. **Python 3.11 trở lên**: https://www.python.org/downloads → khi cài, **tích ô "Add python.exe to PATH"**.
3. **Git**: https://git-scm.com/download/win → Next liên tục.
4. Mở **Command Prompt** (bấm phím Windows, gõ `cmd`, Enter) rồi chạy lần lượt:

```
pip install numpy lightgbm
git clone https://github.com/tader68/abc.git
cd abc
git checkout claude/charming-fermat-jjwcz7
```

Thư mục bot là `abc\crypto-app`. 10 mô hình đã huấn luyện sẵn nằm trong `research\live\models`, nên không cần tự huấn luyện lần đầu.

## 2. Tạo bot Telegram (làm một lần)

1. Trong Telegram, nhắn **@BotFather** → gõ `/newbot` → đặt tên → nhận **token** (dạng `123456:ABC...`). Nếu app ABC Terminal của bạn đã có bot Telegram thì dùng lại token đó.
2. Nhắn một tin bất kỳ cho bot vừa tạo (để bot được phép nhắn lại bạn).
3. Lấy **chat id**: nhắn **@userinfobot**, nó trả về dãy số `Id`.
4. Trong thư mục `crypto-app\research\live`, copy file `config.example.json` thành `config.json`, mở bằng Notepad và điền:

```json
{
  "telegram_token": "123456:ABC...",
  "telegram_chat_id": "987654321",
  "capital_usdt": 300,
  "size": 0.10,
  "threshold": 0.90,
  "max_open": 10
}
```

`capital_usdt` là **số vốn bạn dành cho chiến lược này**. Bot tính số USDT mỗi lệnh từ con số này (10–20% vốn mỗi lệnh).

## 3. Chạy thử

Trong Command Prompt, ở thư mục `abc\crypto-app`:

```
node research\live_export.js
python research\live.py --dry-run
```

Lệnh đầu tải dữ liệu khoảng 1–3 phút, dòng cuối phải ghi nến đóng gần nhất **cách đây dưới 4 giờ** (dữ liệu realtime từ Binance). Lệnh thứ hai in kết quả ra màn hình. Nếu thấy dòng `Đã xử lý nến đóng lúc ...` là chạy được. Chạy `python research\live.py` (bỏ `--dry-run`) để thử gửi Telegram. Nếu nến đó không có tín hiệu thì bot không nhắn gì, chỉ nhắn bản tin buổi sáng vào khung 07:05.

## 4. Cho bot tự chạy

Mở thư mục `crypto-app\research\live`, **nhấp đúp `install_task.bat`**. Bot được đăng ký trong Task Scheduler: kiểm tra mỗi 10 phút (chỉ làm việc khi có nến 4h mới, tự thử lại khi mất mạng), và chạy thêm một lần 2 phút sau khi bạn đăng nhập máy. Nhật ký chạy nằm trong `research\live\log.txt`.

Nên chỉnh Windows để **máy không tự ngủ**: Settings → System → Power → Sleep: **Never** (khi cắm sạc).

## 5. Khi nhận tín hiệu 🟢 MUA

1. Mở Binance → **Futures USDT-M** → coin trong tin nhắn.
2. Chế độ margin **Cross**, đòn bẩy **2x–3x**. Bot có thể mở tới 10 lệnh cùng lúc, mỗi lệnh 10–20% vốn, nên tổng giá trị có lúc vượt số vốn. Đòn bẩy thấp giúp không bị thanh lý.
3. **Long, lệnh Market**, giá trị lệnh bằng số USDT trong tin nhắn.
4. **Nếu giá đã cao hơn mức "BỎ QUA nếu giá đã trên ..." thì đừng vào.** Cơ hội đã qua.
5. Ngay sau khi khớp: đặt **lệnh Limit bán (Reduce Only)** ở giá **+4% so với giá khớp của bạn**.
6. **Không đặt cắt lỗ.** Chiến lược đã được kiểm tra là cắt lỗ làm kết quả tệ hơn. Rủi ro được kiểm soát bằng cách chia nhỏ vốn và thoát theo tin nhắn ⏰ / ⚠️ của bot.

Khi nhận ⏰ hoặc ⚠️ **ĐÓNG LỆNH NGAY**: hủy lệnh limit chốt lời, rồi đóng vị thế bằng lệnh Market.

## 6. Theo dõi kết quả

```
python research\live.py --report
```

In ra tổng số lệnh, tỷ lệ thắng, lãi trung bình và lãi theo tháng của **tất cả tín hiệu bot đã gửi** (tính theo giá mở nến kế tiếp, giống backtest). Hãy so với kết quả thật trên Binance của bạn:

- Backtest kỳ vọng: thắng khoảng 70–90%, lãi trung bình khoảng 2–3%/lệnh, khoảng 6–7 lệnh/tháng.
- Sau 2–3 tháng (khoảng 15–20 lệnh), nếu kết quả gần như vậy thì mới tăng vốn dần.
- Nếu thua liên tục 5–6 lệnh, hoặc tài khoản sụt hơn 20%: dừng lại và xem lại.

## 7. Huấn luyện lại mỗi tháng (không bắt buộc)

Nhấp đúp `research\live\retrain.bat`. Lần đầu bot tải toàn bộ dữ liệu từ 2021 (1–2 giờ, khoảng 3 GB). Các lần sau nhanh hơn nhiều. Xong thì 10 mô hình trong `research\live\models` được thay bằng bản mới.

## Lưu ý quan trọng

- Đây là chiến lược có rủi ro. Năm xấu như 2022 trong backtest vẫn sụt khoảng 30%. **Chỉ dùng số tiền bạn chấp nhận mất.**
- Kết quả quá khứ (khoảng +25–30%/năm sau khi tính cẩn thận) không đảm bảo cho tương lai.
- Bot chỉ đọc dữ liệu công khai và gửi tin nhắn. Không ai cần token Telegram hay tài khoản Binance của bạn. **Đừng đưa file `config.json` cho người khác.**
