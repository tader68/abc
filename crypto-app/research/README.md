# Tìm chiến lược trade (Binance spot / futures)

Công cụ CLI chạy bằng Node ≥ 18, không cần cài thêm thư viện. Bot **chỉ đưa ra tín hiệu**, bạn tự vào lệnh thủ công trên Binance. Bot không dùng API key và không đặt lệnh.

```bash
npm run discover                                   # tìm luật vào/ra lệnh: spot + futures, 40 coin, nến 4h, 8000 nến
npm run rotation                                   # tìm chiến lược xoay vòng coin (xếp hạng định kỳ)
npm run discover -- --no-derivs                    # bỏ dữ liệu phái sinh (tải nhanh hơn)
npm run discover -- --market futures --interval 1h --bars 15000
npm run discover -- --islands 6 --pop 400 --gens 25  # tìm sâu hơn (chậm hơn)
npm run discover -- --synthetic                    # dữ liệu ngẫu nhiên: phải ra "không đạt"
npm run discover -- --synthetic --plant-ar 0.08    # dữ liệu cài sẵn lợi thế: phải tìm ra
npm run research                                   # bản cũ: chỉ so 8 họ chiến lược cổ điển
npm run research:test                              # unit test
```

Nếu máy chủ ở vùng bị Binance chặn (HTTP 451), công cụ tự chuyển sang nguồn chính thức khác của Binance: `data-api.binance.vision` cho spot và kho dữ liệu `data.binance.vision` cho futures. File tải về được lưu đệm trong `research/.cache/`. Nếu chạy sau proxy HTTPS, thêm `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

## `discover` làm gì

1. **Thư viện khoảng 240 chỉ báo** (`features.js`). Bao gồm:
   - Momentum/returns nhiều khung; khoảng cách tới EMA, SMA, WMA, HMA; độ dốc và R² của hồi quy tuyến tính.
   - ADX, DI, Aroon, Vortex, Efficiency Ratio, Choppiness, Ichimoku.
   - RSI 2–28, Stoch, StochRSI, CCI, CMO, MACD (4 bộ tham số), TRIX, AO, DPO.
   - ATR%, tỷ lệ ATR, Bollinger %B và độ rộng, Keltner, vị trí trong kênh Donchian, realized/Parkinson vol, skew, hình dạng nến, chuỗi nến tăng/giảm.
   - Volume z-score, OBV, CMF, MFI, VWAP lệch, Force Index.
   - **Dòng lệnh taker buy/sell** (cumulative delta, số lệnh, kích thước lệnh trung bình), lấy từ dữ liệu klines của Binance.
   - **Dữ liệu phái sinh futures**: funding rate (mức, trung bình, z-score), open interest (thay đổi, phân kỳ với giá, so với volume), tỷ lệ long/short của top trader và toàn thị trường, tỷ lệ taker long/short. Nguồn là kho `data.binance.vision`.
   - **Liên thị trường**: chế độ BTC, sức mạnh tương đối so với BTC, tương quan với BTC.

   Mỗi chỉ báo được quy về **phần trăm thứ hạng trượt** (so với 300 nến gần nhất), nên một ngưỡng như "top 10%" tự thích nghi với từng coin và từng giai đoạn.
2. **Tự tạo chỉ báo mới** (`gp.js`, genetic programming). Thuật toán tiến hóa công thức từ các phép toán như `sma, std, zscore, tsrank, delta, corr, +, −, ×, ÷…` trên giá, khối lượng và dòng lệnh. Độ phù hợp đo bằng IC (tương quan với lợi nhuận tương lai). Chỉ công thức giữ được dấu dự báo ở giai đoạn validation mới được đưa vào thư viện.
3. **Tiến hóa luật** (`search.js`). Mỗi luật ghép 1–3 điều kiện, ví dụ `rsi2 ≤ bottom 10% VÀ atrRatio7_28 ≤ bottom 30%`. Thuật toán chạy trên nhiều "đảo" bằng chọn lọc, đột biến và lai ghép, thử hàng nghìn luật. Các chiến lược cổ điển cũng tham gia cạnh tranh. Mỗi ứng viên được tối ưu thêm 12 kiểu thoát lệnh: SL/TP theo ATR, trailing stop, hoặc đảo chiều.
4. **Phễu chống overfit.** Dữ liệu chia làm 3 phần:
   - **train** (50%): dùng để tìm kiếm.
   - **validation** (25%): giữ lại các ứng viên vẫn lãi và có ít nhất 50% số coin lãi.
   - **hold-out** (25% gần nhất): **không được dùng trong lúc tìm kiếm**, chỉ dùng một lần để chấm điểm 10 ứng viên cuối.

   Một ứng viên chỉ "ĐẠT" khi trên hold-out nó vừa lãi, vừa có t-stat lợi nhuận mỗi lệnh ≥ 2.5, vừa có ít nhất 50% số coin lãi.
5. **Báo cáo** lợi nhuận và MaxDD trên hold-out, so với giữ coin, kèm **% tuần lãi, % tháng lãi, tháng tệ nhất và chuỗi tuần lỗ dài nhất**. Nếu có ứng viên đạt, công cụ in **tín hiệu hiện tại** (Entry, SL, TP, khối lượng theo rủi ro 1% vốn). Toàn bộ kết quả được lưu vào `discover-results.json`.

## `rotation`: chiến lược xoay vòng coin

Cứ mỗi R ngày (1, 3 hoặc 7), công cụ xếp hạng toàn bộ coin theo một chỉ báo rồi chọn danh mục:

- **Spot:** giữ K coin đứng đầu (K = 3, 5 hoặc 8). Có tuỳ chọn chỉ giữ coin khi BTC nằm trên EMA100.
- **Futures:** chỉ Long, hoặc Long nhóm đầu kết hợp Short nhóm cuối (trung lập với thị trường).

Công cụ thử mọi chỉ báo trong thư viện theo cả hai chiều, cộng các cặp kết hợp từ 20 chỉ báo tốt nhất. Tổng cộng hơn 10.000 cấu hình, và tất cả đều đi qua cùng phễu train → validation → hold-out. Điểm khác là phép kiểm định trên hold-out dùng t-stat của lợi nhuận theo tuần, với ngưỡng ≥ 2.5. Kết quả có tính phí giao dịch theo vòng quay danh mục và funding. Nếu có cấu hình đạt, công cụ in **danh mục hiện tại** (coin nào Long, coin nào Short, tỷ trọng bao nhiêu).

## Vì sao phải khắt khe như vậy

Thử hàng nghìn luật thì chắc chắn sẽ có luật trông rất đẹp trên dữ liệu quá khứ chỉ nhờ may mắn. Phễu train → validation → hold-out cùng ngưỡng t-stat là để lọc bỏ chúng. Công cụ đã được kiểm chứng theo hai chiều:

- Trên dữ liệu ngẫu nhiên, không ứng viên nào đạt (t-stat 0.4–0.8).
- Trên dữ liệu được cài sẵn lợi thế (momentum, hoặc dòng lệnh taker dự báo giá), công cụ tìm ra được, và GP tự phát hiện đúng biến chứa lợi thế.

## Giới hạn

- Engine giả định khớp lệnh ở giá mở nến kế tiếp, có phí, trượt giá cố định và funding. Funding của tháng hiện tại chưa có trong kho dữ liệu, nên được ước tính bằng mức funding gần nhất.
- Chiến lược xoay vòng giữ tỷ trọng cố định giữa hai lần rebalance (một phép xấp xỉ).
- Kết quả phụ thuộc giai đoạn dữ liệu. Hãy chạy lại định kỳ (ví dụ mỗi tháng) và thử với vốn nhỏ trước khi tin vào bất kỳ kết quả nào.
