#!/usr/bin/env python3
"""Builds research/live/dashboard.html: a self-contained page (no server needed) showing the bot's health,
open positions with current P&L, closed trades, monthly results, equity curve and the latest coins the models
scored. run.py rebuilds it after every check, so opening the file (Desktop shortcut) always shows fresh data.

    python3 research/live/dashboard.py
"""
import datetime as dt
import html
import json
from pathlib import Path

import numpy as np

LIVE = Path(__file__).resolve().parent
RESEARCH = LIVE.parent
OUT = LIVE / 'dashboard.html'
BAR = 4 * 3600_000


def load(p, default):
    try:
        return json.loads(Path(p).read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001 - missing / partially written file
        return default


def vn(ms):
    return (dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc) + dt.timedelta(hours=7)).strftime('%d/%m %H:%M')


def now_ms():
    return dt.datetime.now(dt.timezone.utc).timestamp() * 1000


def esc(x):
    return html.escape(str(x))


def last_prices(symbols):
    """Latest close (and its time) of each symbol from the live panel."""
    D = RESEARCH / '.cache/live/panel'
    meta = load(D / 'meta.json', None)
    if not meta:
        return {}, None
    n = meta['n']
    out = {}
    for s in symbols:
        f = D / f'P_{s}.bin'
        if f.exists():
            P = np.fromfile(f, dtype=np.float64).reshape(n, 5)
            ok = np.where(np.isfinite(P[:, 3]))[0]
            if len(ok):
                out[s] = float(P[ok[-1], 3])
    return out, meta['t'][-1] + BAR


def runs_tail(k=400):
    f = LIVE / 'history/runs.jsonl'
    if not f.exists():
        return []
    lines = f.read_text(encoding='utf-8').splitlines()[-k:]
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def build():
    cfg = {'capital_usdt': 1000, **load(LIVE / 'config.json', {})}
    st = load(LIVE / 'state.json', {'last_bar': 0, 'open': [], 'closed': []})
    rs = load(LIVE / 'history/runner.json', {})
    runs = runs_tail()
    real_open = [p for p in st.get('open', []) if not p.get('missed')]
    prices, data_close = last_prices({p['symbol'] for p in real_open})
    now = now_ms()

    # ---------- health ----------
    last_ok = rs.get('last_ok')
    fails24 = [r for r in runs if r.get('type') == 'fail']
    fails24 = [r for r in fails24 if r.get('run_at')][-20:]
    age_h = (now - (st['last_bar'] + BAR)) / 3.6e6 if st.get('last_bar') else None
    if age_h is None:
        health, tone = 'Chưa chạy lần nào', 'warn'
    elif age_h <= 4.5:
        health, tone = 'Đang chạy bình thường', 'good'
    elif age_h <= 12:
        health, tone = 'Đang trễ, sẽ tự thử lại', 'warn'
    else:
        health, tone = 'Không chạy được (mất mạng / máy ngủ?)', 'bad'

    # ---------- closed trades ----------
    closed = sorted(st.get('closed', []), key=lambda c: c.get('exit_t', 0))
    real_closed = [c for c in closed if not c.get('missed')]
    rets = np.array([c['ret'] for c in real_closed]) if real_closed else np.array([])
    eq, curve = 1.0, []
    months = {}
    for c in real_closed:
        eq *= 1 + c['ret'] * c['size']
        curve.append((c['exit_t'], eq))
        key = (dt.datetime.fromtimestamp(c['exit_t'] / 1000, dt.timezone.utc) + dt.timedelta(hours=7)).strftime('%m/%Y')
        m = months.setdefault(key, [0.0, 0, 0])
        m[0] += c['ret'] * c['size']
        m[1] += 1
        m[2] += c['ret'] > 0
    total = (eq - 1) * 100
    usd = (eq - 1) * cfg['capital_usdt']

    # ---------- equity curve (inline SVG) ----------
    svg = '<p class="muted">Chưa có lệnh nào đóng.</p>'
    if len(curve) >= 2:
        W, Hh = 640, 160
        xs = np.array([c[0] for c in curve], dtype=float)
        ys = np.array([1.0] + [c[1] for c in curve])
        xs = np.r_[xs[0] - 1, xs]
        x = (xs - xs.min()) / max(1, xs.max() - xs.min()) * (W - 20) + 10
        lo, hi = ys.min(), ys.max()
        y = Hh - 10 - (ys - lo) / max(1e-9, hi - lo) * (Hh - 20)
        pts = ' '.join(f'{a:.1f},{b:.1f}' for a, b in zip(x, y))
        base = Hh - 10 - (1 - lo) / max(1e-9, hi - lo) * (Hh - 20)
        svg = (f'<svg viewBox="0 0 {W} {Hh}" class="chart" role="img" aria-label="Đường vốn">'
               f'<line x1="10" x2="{W - 10}" y1="{base:.1f}" y2="{base:.1f}" class="axis"/>'
               f'<polyline points="{pts}" class="line"/></svg>')

    # ---------- open positions ----------
    rows = []
    for p in sorted(real_open, key=lambda q: q['signal_t']):
        cur = prices.get(p['symbol'])
        entry = p.get('entry') or p.get('signal_close')
        pnl = (cur / entry - 1) * 100 if cur and entry else None
        left_h = (p['deadline_t'] - now) / 3.6e6
        tp = p.get('tp_price') or (entry * 1.04 if entry else None)
        rows.append(f"<tr><td><b>{esc(p['symbol'][:-4])}</b></td><td>{vn(p['signal_t'] + BAR)}</td><td>{entry:.6g}</td>"
                    f"<td>{tp:.6g}</td><td>{cur:.6g}</td><td class=\"{'pos' if (pnl or 0) >= 0 else 'neg'}\">{pnl:+.1f}%</td>"
                    f"<td>{p['size'] * 100:.0f}% · {p['size'] * cfg['capital_usdt']:.0f}$</td>"
                    f"<td>{'quá hạn: đóng ngay' if left_h <= 0 else f'{left_h:.0f} giờ'}</td></tr>" if cur and entry else
                    f"<tr><td><b>{esc(p['symbol'][:-4])}</b></td><td>{vn(p['signal_t'] + BAR)}</td><td colspan=6>đang chờ giá…</td></tr>")
    open_html = ('<table><thead><tr><th>Coin</th><th>Tín hiệu</th><th>Giá vào</th><th>Chốt lời</th><th>Giá hiện tại</th>'
                 '<th>Lãi/lỗ</th><th>Vốn</th><th>Còn lại</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table>'
                 if rows else '<p class="muted">Không có lệnh nào đang mở. Bot chờ cú bán tháo tiếp theo.</p>')

    # ---------- closed table ----------
    why = {'tp': 'Chốt lời', 'time': 'Hết 48h', 'market': 'Thị trường sập'}
    crow = ''.join(
        f"<tr><td>{esc(c['symbol'][:-4])}</td><td>{vn(c['signal_t'] + BAR)}</td><td>{vn(c['exit_t'])}</td><td>{why.get(c['reason'], c['reason'])}</td>"
        f"<td class=\"{'pos' if c['ret'] > 0 else 'neg'}\">{c['ret'] * 100:+.2f}%</td><td>{c['ret'] * c['size'] * 100:+.2f}%</td></tr>"
        for c in reversed(real_closed[-30:]))
    closed_html = ('<table><thead><tr><th>Coin</th><th>Vào</th><th>Ra</th><th>Lý do</th><th>Lãi/lệnh</th><th>Tác động lên vốn</th></tr></thead><tbody>'
                   + crow + '</tbody></table>') if crow else '<p class="muted">Chưa có lệnh nào đóng.</p>'
    mrow = ''.join(f"<tr><td>{k}</td><td>{v[1]}</td><td>{v[2] / v[1] * 100:.0f}%</td><td class=\"{'pos' if v[0] >= 0 else 'neg'}\">{v[0] * 100:+.1f}%</td></tr>"
                   for k, v in months.items())
    month_html = ('<table><thead><tr><th>Tháng</th><th>Lệnh</th><th>Thắng</th><th>Lãi trên vốn</th></tr></thead><tbody>' + mrow + '</tbody></table>') if mrow else ''

    # ---------- radar: latest scored candidates ----------
    last_run = next((r for r in reversed(runs) if r.get('type') == 'run'), None)
    radar = '<p class="muted">Chưa có dữ liệu.</p>'
    if last_run:
        cands = sorted(last_run.get('candidates', []), key=lambda c: -c['p'])[:12]
        act = {'signal': 'ĐÃ BÁO MUA', 'below_threshold': 'chưa đủ ngưỡng', 'full': 'đủ 10 lệnh'}
        if cands:
            radar = ('<table><thead><tr><th>Coin</th><th>Rơi 24h</th><th>Xác suất thắng</th><th></th></tr></thead><tbody>' + ''.join(
                f"<tr><td>{esc(c['symbol'][:-4])}</td><td class=\"neg\">{c['drop24'] * 100:.1f}%</td>"
                f"<td><div class=\"bar\"><span style=\"width:{max(0, min(100, c['p'] * 100)):.0f}%\" class=\"{'hot' if c['p'] >= 0.9 else ''}\"></span></div>{c['p'] * 100:.0f}%</td>"
                f"<td>{act.get(c['action'], '')}</td></tr>" for c in cands) + '</tbody></table>')
        else:
            radar = '<p class="muted">Nến gần nhất không có coin nào rơi ≥6% trong 24h, thị trường đang yên.</p>'
        radar = f"<p class=\"muted\">Nến đóng lúc {esc(last_run.get('bar_close', ''))} · ngưỡng mua: 90%</p>" + radar

    stat = lambda label, value, cls='': f'<div class="stat"><div class="label">{label}</div><div class="value {cls}">{value}</div></div>'  # noqa: E731
    stats = ''.join([
        stat('Lệnh đã đóng', len(real_closed)),
        stat('Tỷ lệ thắng', f'{(rets > 0).mean() * 100:.0f}%' if len(rets) else '–'),
        stat('Lãi TB/lệnh', f'{rets.mean() * 100:+.2f}%' if len(rets) else '–', 'pos' if len(rets) and rets.mean() > 0 else ''),
        stat('Tổng trên vốn', f'{total:+.1f}% · {usd:+.0f}$', 'pos' if total >= 0 else 'neg'),
    ])
    missed = len([c for c in closed if c.get('missed')]) + len([p for p in st.get('open', []) if p.get('missed')])
    fail_html = ''.join(f"<li>{esc(r['run_at'])}: {esc(str(r.get('error', ''))[-160:])}</li>" for r in reversed(fails24[-5:]))

    page = f'''<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="300"><title>Bot tín hiệu</title><style>
:root{{--bg:#f6f7f9;--card:#fff;--text:#1b1f24;--muted:#6b7280;--line:#e5e7eb;--pos:#0f8a4b;--neg:#c2321f;--accent:#2563eb;--warn:#b7791f}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0f1115;--card:#171a21;--text:#e6e8eb;--muted:#9aa3ae;--line:#272b35;--pos:#3ccf7e;--neg:#ff6b5a;--accent:#6ea8ff;--warn:#e7b04a}}}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}}
main{{max-width:980px;margin:0 auto;padding:20px 16px 40px}}h1{{font-size:22px;margin:0 0 4px}}h2{{font-size:16px;margin:0 0 10px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:14px;overflow-x:auto}}
.muted{{color:var(--muted);margin:4px 0}}.pill{{display:inline-block;padding:3px 10px;border-radius:99px;font-weight:600;font-size:13px}}
.good{{background:color-mix(in srgb,var(--pos) 15%,transparent);color:var(--pos)}}.warn{{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}}
.bad{{background:color-mix(in srgb,var(--neg) 15%,transparent);color:var(--neg)}}
.stats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}}.stat{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}}
.label{{color:var(--muted);font-size:13px}}.value{{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}}
table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:14px}}th,td{{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}}
th{{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}}.pos{{color:var(--pos)}}.neg{{color:var(--neg)}}
.chart{{width:100%;height:auto}}.chart .line{{fill:none;stroke:var(--accent);stroke-width:2.5}}.chart .axis{{stroke:var(--line);stroke-dasharray:4 4}}
.bar{{display:inline-block;width:90px;height:8px;background:var(--line);border-radius:4px;margin-right:8px;vertical-align:middle;overflow:hidden}}
.bar span{{display:block;height:100%;background:var(--muted)}}.bar span.hot{{background:var(--pos)}}
.grid2{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}@media (max-width:720px){{.grid2{{grid-template-columns:1fr}}}}.grid2 .card{{margin-top:0}}
ul{{margin:6px 0;padding-left:18px}}li{{color:var(--muted);font-size:13px}}
</style></head><body><main>
<h1>Bot tín hiệu · mua sau bán tháo</h1>
<p class="muted">Cập nhật {vn(now)} · trang tự làm mới mỗi 5 phút · vốn khai báo {cfg['capital_usdt']:.0f}$</p>
<div class="card"><span class="pill {tone}">{health}</span>
<p class="muted">Nến đã xử lý gần nhất: {vn(st['last_bar'] + BAR) if st.get('last_bar') else '–'} · lần chạy thành công gần nhất: {vn(last_ok * 1000) if last_ok else '–'}
· tín hiệu bị lỡ (máy tắt / mất mạng): {missed}</p>{'<ul>' + fail_html + '</ul>' if fail_html and tone != 'good' else ''}</div>
<div class="stats" style="margin-top:14px">{stats}</div>
<div class="card"><h2>Lệnh đang mở ({len(real_open)}/{cfg.get('max_open', 10)})</h2>{open_html}
<p class="muted">Đóng ngay bằng lệnh Market khi Telegram báo ⏰ / ⚠️, hoặc khi cột "Còn lại" ghi quá hạn.</p></div>
<div class="grid2" style="margin-top:14px"><div class="card"><h2>Đường vốn (các lệnh đã đóng)</h2>{svg}</div>
<div class="card"><h2>Theo tháng</h2>{month_html or '<p class="muted">Chưa có.</p>'}
<p class="muted">Kỳ vọng từ backtest: thắng ~70–90%, lãi TB 2–3%/lệnh, ~6–7 lệnh/tháng, +25–30%/năm.</p></div></div>
<div class="card"><h2>Radar: coin đang bị bán tháo</h2>{radar}</div>
<div class="card"><h2>Lịch sử lệnh</h2>{closed_html}</div>
<p class="muted" style="margin-top:16px">Kết quả tính theo giá mở nến kế tiếp như backtest; kết quả thật trên Binance của bạn có thể lệch một chút. Hỏi nhanh trên Telegram: /baocao · /lenh · /trangthai</p>
</main></body></html>'''
    OUT.write_text(page, encoding='utf-8')
    return OUT


if __name__ == '__main__':
    print(f'Đã tạo {build()}')
