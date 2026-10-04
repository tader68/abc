# Tìm chiến lược tốt nhất (Binance spot / futures)

Công cụ CLI chạy bằng Node ≥ 18, không cần cài thêm thư viện. Bot **chỉ đưa ra tín hiệu**, bạn tự vào lệnh thủ công trên Binance. Bot không dùng API key và không đặt lệnh.

```bash
npm run research                                   # spot + futures, 8 coin, nến 1h, 5000 nến
npm run research -- --market futures --interval 4h --bars 3000
npm run research -- --symbols BTCUSDT,ETHUSDT --out ket-qua.json
npm run research -- --synthetic                    # dữ liệu giả, kiểm tra offline
npm run research:test                              # unit test engine
```

## Cách hoạt động

- **4 họ chiến lược**: EMA cross, Donchian breakout, RSI reversion, Bollinger reversion. Mỗi họ có lưới tham số, cộng với lưới SL/TP theo ATR. Tổng cộng khoảng 270 tổ hợp.
- **Engine**: tín hiệu chốt ở lúc đóng nến, vào lệnh ở giá mở nến kế tiếp (không nhìn trước tương lai). Có tính phí và trượt giá. Khi nến chạm cả SL và TP, SL được tính trước. Mỗi lệnh rủi ro 1% vốn tại SL.
  - **Spot**: chỉ Long, đòn bẩy 1x, phí 0.1%/chiều.
  - **Futures**: Long và Short, đòn bẩy tối đa 3x, phí 0.05%/chiều.
- **Walk-forward**: tối ưu tham số trên cửa sổ train (mặc định 1500 nến), rồi chấm điểm trên cửa sổ test kế tiếp (500 nến) mà tham số chưa từng thấy. Lặp lại trượt dọc dữ liệu. Chỉ kết quả **ngoài mẫu** được dùng để xếp hạng.
- Kết quả được so với "giữ coin" và chỉ gọi là có lợi thế khi lãi ở ít nhất 60% cửa sổ và tổng thể dương. Nếu không, công cụ nói thẳng là không tìm thấy lợi thế.
- Cuối cùng in ra các **tín hiệu hiện tại** (Entry tham khảo, SL, TP, khối lượng gợi ý theo 1% rủi ro) và ghi toàn bộ kết quả ra file JSON.

## Giới hạn

- Chưa tính funding rate của futures.
- Quá khứ không đảm bảo tương lai. Hãy chạy lại định kỳ và thử nghiệm với vốn nhỏ trước.
