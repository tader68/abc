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

## Các nghiên cứu khác

| Lệnh | Câu hỏi |
|---|---|
| `npm run dipstudy` / `npm run dipverify` | Mua khi giá rơi có lợi thế không? So với mua ngẫu nhiên, có tính coin đã chết, có kiểm tra khả năng khớp lệnh. |
| `npm run carry` | Funding carry (mua spot, short futures) lãi bao nhiêu và đều đến mức nào? |
| `npm run sentiment` | Canh thời điểm theo chỉ số Fear & Greed và dòng tiền stablecoin có thắng được giữ luôn không? |
| `npm run fundamentals` | Token có phí/doanh thu tăng (theo DefiLlama) có tăng giá tốt hơn không? |
| `npm run listings` | Coin mới niêm yết trên Binance diễn biến thế nào trong năm đầu? |
| `npm run shortlistings` | Short coin mới trên futures (có cắt lỗ, funding, cháy tài khoản) có lãi không? Thêm `--slip 0.01` để test với trượt giá 1%. |
| `npm run ml:export` rồi `npm run ml` | Mô hình LightGBM kết hợp khoảng 240 chỉ báo có dự đoán được hướng giá hoặc xếp hạng coin không? Walk-forward huấn luyện lại hàng tháng, kèm kiểm tra placebo bằng `--placebo`. Cần Python với `pip install lightgbm scipy numpy`. |
| `npm run replicate` | Tái hiện các phát hiện đã công bố: BTC theo giờ trong ngày (21–23h UTC), đảo chiều ngắn hạn, hiệu ứng MAX, momentum 1–3 tuần. So sánh giai đoạn của bài báo với các năm sau khi công bố. |
| `npm run replicate2` | Tái hiện thêm: pairs trading theo đồng tích hợp, BTC dẫn trước altcoin (nến 5 phút), ngày trong tuần, chỉ báo on-chain MVRV (dữ liệu CoinMetrics). |
| `npm run social` | Các setup phổ biến trên TradingView/YouTube (Triple Supertrend + RSI + EMA200, EMA 20/50/200, RSI + Bollinger scalping) trên BTC/ETH/SOL, có phí. |
| `npm run signals -- file.txt` | Kiểm tra tín hiệu của một kênh bằng giá thật Binance: lệnh có khớp không, chạm TP hay cắt lỗ trước, tổng thắng/thua sau phí. Định dạng xem `research/signals.example.txt`. |
| `npm run ml:improve -- --pred file.npz` | Cải tiến chiến lược ML "mua sau bán tháo" với engine theo sự kiện (mỗi 4h, giới hạn vốn mỗi lệnh, TP/SL, điều kiện coin vừa rơi). Chọn trên 2022–2024, kiểm tra một lần trên 2025 → nay. |
| `npm run ml:macro` rồi `npm run ml -- --dir research/.cache/ml/panel_4h --macro` | Thêm 39 chỉ báo vĩ mô và sự kiện vào mô hình ML: S&P 500, Nasdaq, VIX, đô la (DXY), lợi suất trái phiếu Mỹ 10 năm, vàng, dầu, volume ETF BTC, lượt xem Wikipedia (độ chú ý của đám đông), lịch họp Fed (FOMC) và báo cáo việc làm Mỹ (NFP). Mỗi nến chỉ dùng dữ liệu của ngày đã đóng cửa. Kết quả (10/2026): mô hình dựa vào dữ liệu vĩ mô nhiều nhất, nhưng tệ hơn rõ rệt ở 2022–2024 (sụt 35–40%) và tốt hơn ở 2025 → nay. Lợi thế không ổn định, nên bản không có dữ liệu vĩ mô vẫn là bản chính. `ml:improve -- --context` tách lệnh theo bối cảnh vĩ mô. |
| `python3 research/ml_event.py --save ev.npz` rồi `npm run ml:improve -- --pred ev.npz --thr-mode abs` | **Mô hình sự kiện:** chỉ học trên những lần coin rơi ≥5% trong 24h (99 coin, có coin đã chết), và dự đoán chính lệnh sẽ vào có lãi không (vào ở giá mở nến sau, chốt lời hoặc hết thời gian giữ, có phí và funding). Kết quả (10/2026), biến thể đứng đầu giai đoạn chọn (xác suất ≥85%, giữ tối đa 1 ngày, chốt lời +8%, 20 coin lớn, 10% vốn mỗi lệnh): 2022–2024 +48.8%/năm, sụt 26%; **kiểm tra 2025–nay +18.9%/năm, sụt 5%, t=5.3**. Đã kiểm tra: placebo (xáo nhãn) cho −14%/năm; phí ×3 vẫn +15%/năm; đổi seed cho kết quả gần như giống hệt. Năm 2026 đến nay −4%. Thêm `--side short` để thử short sau khi bị bơm: không có lợi thế. |
| `python3 research/ml_ensemble.py --out ens.npz ev_long.npz ev_long_s7.npz ev_any.npz` | **Bản tốt nhất hiện tại (10/2026):** trung bình 3 mô hình sự kiện (seed 0, seed 7, và bản thêm sự kiện funding/OI/volume bằng `--event-type any`). Biến thể đứng đầu giai đoạn chọn: mua khi xác suất ≥85% và coin rơi ≥6% trong 24h, chốt lời +4%, không chạm thì thoát sau 2 ngày, 20 coin lớn, 10% vốn mỗi lệnh. 2022–2024: +24.5%/năm, sụt 11.8%. **Kiểm tra 2025–nay: +18.1%/năm, sụt 0.5%, thắng 90%, 97 lệnh** (2025 +19%, 2026 +13%). Phí ×3 vẫn +15.6%/năm. Đã thử và không giúp: cắt lỗ cứng, thoát khi BTC/thị trường sập tiếp, giới hạn số lệnh mở, để mô hình tự chọn TP/thời gian giữ (`ml_plan.py`: lãi cao hơn nhưng sụt 34%), sự kiện funding/OI/volume riêng lẻ (gần như không bao giờ đủ tự tin). |
| `npm run ml:improve -- --pred ens.npz --thr-mode abs --only 0.85,12,0.04,0,0.06,all --mkt-exit 0.05 --conf-size 1` | **Bản tăng lợi nhuận (10/2026):** như bản ghép 3 mô hình, nhưng trade **mọi coin futures** (`all`, kể cả coin sau này chết như LUNA, FTT, SRM), **thoát sớm khi coin trung vị của thị trường rơi thêm 5% kể từ lúc vào** (`--mkt-exit 0.05`: dip đã biến thành sập), và **lệnh càng tự tin càng nhiều vốn** (`--conf-size 1`: 10–20% vốn). 2022–2024: +48.5%/năm, sụt 22.9% (2022 +34%, 2023 +16%, 2024 +103%). **Kiểm tra 2025–nay: +44.5%/năm, sụt 3.2%** (2025 +63%, 2026 +17%), khoảng 9 lệnh/tháng. Phí ×2: +40.9%/năm. Placebo cùng cấu hình: −11%/năm. `--mkt-exit` 0.04–0.06 cho kết quả gần như nhau. Đã thử và không giúp: lọc coin theo tuổi niêm yết, tăng vốn mỗi lệnh lên 15–20% với 20 coin. |
| Thử thêm (10/2026) | **Chốt lời từng phần** (`--tp-frac 0.5 --tp2 0.08`, giữ tối đa 3 ngày): cải thiện nhẹ (2022–2024 sụt 20% thay vì 23%; 2025–nay +51%/năm thay vì +44.5%). **Ghép thêm mô hình** (5–6 mô hình): không tốt hơn; các cách ghép khác nhau cho 2025–nay từ +24% đến +45%/năm, sụt 3–19%, nên con số +44.5% nằm ở đầu may mắn; kỳ vọng thực tế khoảng +25–35%/năm. **Nến 1h** (`mlexport2.js --interval 1h`, `ml_event.py --dir .cache/ml/panel_1h --bars-per-day 24 --hold 48 --subsample 4`): không tốt hơn 4h (bắt được nhiều cú rơi giữa chừng; với mọi coin sụt 60% năm 2022). |
| **Bản ổn định (10/2026)** | 10 mô hình sự kiện **cùng cấu hình**, chỉ khác seed (`ml_event.py --seed k`, TP 4%, giữ 48h), lấy trung bình bằng `ml_ensemble.py`. Engine ưu tiên tín hiệu mạnh nhất khi hết slot (trước đây chọn theo thứ tự tên coin). Cấu hình: `--thr-mode abs --only 0.9,12,0.04,0,0.06,all --mkt-exit 0.05 --conf-size 1`, khoảng 6–7 lệnh/tháng. Bộ 10 mô hình: 2022–2024 +53%/năm, sụt 30%; **2025–nay +26%/năm, sụt 3.5%**; năm nào cũng lãi. **Kiểm tra độ ổn định:** hai nhóm 5 seed độc lập cho 2025–nay +26.9% và +29.3%/năm (sụt 3.5% và 3.1%), 2022–2024 +53.5% và +57.1%/năm. Phí ×2: +23.9%/năm. Đã thử và không giúp ổn định hơn: ngưỡng theo thứ hạng (`--rank-days`, sụt tới 48%), giới hạn lệnh mới mỗi nến (`--max-new`), chia vốn theo biến động (`--vol-size`). Ngưỡng 0.8 lãi cao hơn nhưng khoảng 60 lệnh/tháng, sụt 27–35%. |
| `python3 research/extdata.py` rồi `ml_event.py --ext [--ext-drop ...]` | **Nguồn dữ liệu mới (10/2026):** premium index từng coin, Coinbase premium, DVOL (Deribit), sổ lệnh BTC ±1/2/5% (2023+), tổng cung stablecoin. So với cùng 5 seed không có dữ liệu mới (ngưỡng 0.9): **đủ 18 chỉ báo → tệ hơn** (2025–nay +23.6%/năm, sụt 10.9% so với +26.9%, sụt 3.5%); mô hình bám vào biến chậm (mức DVOL, stablecoin) như từng xảy ra với dữ liệu vĩ mô. **Chỉ các biến nhanh** (`--ext-drop dvol_btc,dvol_eth,stables_chg7,stables_chg30`) → ngang bằng (2022–2024 +53.1%, sụt 24.8%; 2025–nay +25.3%, sụt 3.1%), nằm trong mức dao động giữa các nhóm seed, nên không giữ. |
| `--idle-carry 1` | Cho phần vốn đang để không chạy funding carry BTC/ETH (spot long + perp short, trừ 1%/năm chi phí): +4%/năm ở 2022–2024, +1.3%/năm ở 2025–nay, mức sụt không đổi. Ước tính lạc quan vì giả định chuyển vốn qua lại tức thì. |

## Bot tín hiệu (chạy thật)

Hướng dẫn cài đặt chi tiết bằng tiếng Việt: [`research/live/HUONG_DAN.md`](live/HUONG_DAN.md).

- `research/live/models/`: 10 mô hình sự kiện huấn luyện trên toàn bộ dữ liệu (`ml_event.py --final`), kèm `meta.json` (danh sách chỉ báo, coin, ngày huấn luyện).
- `research/live_export.js`: tải 1500 nến 4h gần nhất của từng coin từ fapi.binance.com cùng funding, tính đúng các chỉ báo như lúc huấn luyện (đã kiểm tra: 99.9% thứ hạng chỉ báo trùng với panel huấn luyện).
- `research/live.py`: theo dõi lệnh mở (chốt lời +4%, hết 48h, thị trường rơi thêm 5%), tìm tín hiệu mới (rơi ≥6%/24h, xác suất trung bình ≥90%, tối đa 10 lệnh, 10–20% vốn mỗi lệnh), gửi Telegram và ghi `state.json` để so kết quả thật với backtest. `--dry-run`, `--replay N`, `--report`.
- `research/event_features.py`: phần phát hiện sự kiện và chỉ báo bối cảnh dùng chung cho huấn luyện và bot (tái tạo đúng kết quả cũ, sai số 0).
- Windows: `research/live/run_live.bat`, `install_task.bat` (Task Scheduler mỗi 4h và khi đăng nhập), `retrain.bat`. Mac/Linux: `run_live.sh` + cron.

