"""病历整理工具：一个 JSON 文件 → 病程时间线（PDF + Excel）、一页就诊沟通单（PDF）、动态血糖汇总（PDF，可选）。

用法：python brief.py sample/patient.json out/
需要：Python 3.9+、openpyxl、Chrome / Edge / Chromium（用来把 HTML 打印成 PDF）。
"""
import datetime, html, json, os, re, shutil, subprocess, sys, tempfile

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    Workbook = None

e = html.escape


def md(s):
    """转义后只保留 **加粗**。"""
    return re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', e(str(s or '')))


def find_browser():
    if os.environ.get('CHROME'):
        return os.environ['CHROME']
    cands = [
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    for n in ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'):
        if shutil.which(n):
            return shutil.which(n)
    sys.exit('找不到 Chrome / Edge / Chromium，请安装，或用环境变量 CHROME 指定路径。')


def to_pdf(doc, pdf, browser):
    with tempfile.TemporaryDirectory() as td:
        h = os.path.join(td, 'page.html')
        with open(h, 'w', encoding='utf-8') as f:
            f.write(doc)
        url = 'file:///' + h.replace('\\', '/').lstrip('/')
        subprocess.run([browser, '--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--allow-file-access-from-files',
                        f'--print-to-pdf={os.path.abspath(pdf)}', url], timeout=180, capture_output=True)
    return os.path.exists(pdf)


BASE_CSS = '''@page { size: A4; margin: 12mm; }
body { font: 9.5pt/1.5 "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif; color:#1c2321; margin:0; }
h1 { font-size: 17pt; margin: 0 0 2px; } h2 { font-size: 12pt; margin: 14px 0 6px; color:#0f766e; border-bottom: 2px solid #0f766e; padding-bottom: 2px; }
h3 { font-size: 10.5pt; margin: 8px 0 3px; color:#0f766e; border-bottom: 1.5px solid #0f766e; padding-bottom: 1px; }
.sub, .meta { color:#5d6764; font-size: 9pt; margin-bottom: 8px; }
table { width:100%; border-collapse: collapse; } td, th { border:1px solid #d5dbd8; padding: 3px 5px; vertical-align: top; text-align:left; }
th { background:#0f766e; color:#fff; font-weight:600; } thead { display: table-header-group; } tr { page-break-inside: avoid; }
tr.day td { background:#e6f3f1; font-weight:700; color:#0f766e; }
.w { color:#8a4b00; } tr.abn td { background:#fdecec; }
.red { border:1.5px solid #c62828; background:#fdecec; padding:5px 9px; border-radius:6px; margin:6px 0; } .red b { color:#c62828; }
.key { border:1.5px solid #0f766e; background:#f0faf8; padding:6px 10px; border-radius:6px; margin:8px 0; }
ul, ol { margin: 2px 0; padding-left: 18px; } li { margin: 1px 0; }
.small li { font-size: 8.8pt; color:#444; } .foot { color:#5d6764; font-size: 8.3pt; margin-top: 6px; }
.label td:first-child { width: 90px; white-space: nowrap; color:#0f766e; font-weight:600; }
.pb { page-break-after: always; }
.page { page-break-after: always; } .page:last-child { page-break-after: auto; }
.pair { display:flex; gap:8px; } .pair img { width:49%; max-height:240mm; object-fit:contain; border:1px solid #ddd; }
.wide img { display:block; width:100%; max-height:125mm; object-fit:contain; border:1px solid #ddd; margin-bottom:6px; }
'''


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, outdir = sys.argv[1], sys.argv[2]
    base = os.path.dirname(os.path.abspath(src))
    d = json.load(open(src, encoding='utf-8'))
    os.makedirs(outdir, exist_ok=True)
    browser = find_browser()

    P = d['patient']
    name = P.get('name', '病人')
    onset = datetime.date.fromisoformat(P['onset']) if P.get('onset') else None
    today = P.get('updated') or datetime.date.today().isoformat()
    stamp = today.replace('-', '')

    def day(ds):
        try:
            return f'第{(datetime.date.fromisoformat(ds) - onset).days + 1}天' if onset else ''
        except ValueError:
            return ''

    T = sorted(d.get('timeline', []), key=lambda r: (r['date'], r.get('time', '')))
    meds, labs, todo, bg = d.get('meds', []), d.get('labs', []), d.get('todo', []), d.get('background', [])
    who = f"{e(name)}　{e(P.get('sex', ''))}　{e(str(P.get('age', '')))} 岁"

    # ---------- 一页就诊沟通单 ----------
    B = d.get('brief', {})
    ul = lambda items, cls='': f'<ul class="{cls}">' + ''.join(f'<li>{md(x)}</li>' for x in items) + '</ul>' if items else ''
    one = f'<h1>就诊沟通单</h1><div class="meta">{who}　｜　家属整理于 {e(today)}'
    if onset:
        one += f'　｜　病程第 {(datetime.date.fromisoformat(today) - onset).days + 1} 天'
    one += '</div>'
    if d.get('allergies'):
        one += f'<div class="red"><b>⚠ {md(d["allergies"])}</b></div>'
    if B.get('why'):
        one += f'<h3>这次为什么来</h3>{ul(B["why"])}'
    if B.get('history'):
        one += f'<h3>既往史与目前用药</h3>{ul(B["history"])}'
    if B.get('exams'):
        one += '<h3>已做的检查（关键结果）</h3><table class="label">' + ''.join(f'<tr><td>{e(a)}</td><td>{md(b)}</td></tr>' for a, b in B['exams']) + '</table>'
    if B.get('questions'):
        one += '<h3>最想问医生的</h3><ol>' + ''.join(f'<li>{md(x)}</li>' for x in B['questions']) + '</ol>'
    if B.get('more'):
        one += f'<h3>时间允许再问</h3>{ul(B["more"], "small")}'
    one += '<div class="foot">本单只列事实和问题，不是诊断。逐日时间线、用药和检验明细见「病程事实时间线」。</div>'

    # ---------- Excel ----------
    xlsx = None
    if Workbook:
        wb = Workbook()
        thin = Side(style='thin', color='CCCCCC'); BD = Border(left=thin, right=thin, top=thin, bottom=thin)
        HF = PatternFill('solid', fgColor='0F766E'); WARN = PatternFill('solid', fgColor='FFF4E0'); ABN = PatternFill('solid', fgColor='FDECEC')

        def sheet(ws, head, rows, widths, warn_col=None, abn_col=None):
            ws.append(head)
            for c in ws[1]:
                c.font = Font(bold=True, color='FFFFFF'); c.fill = HF; c.alignment = Alignment(vertical='center', wrap_text=True); c.border = BD
            for r in rows:
                ws.append(list(r)); row = ws[ws.max_row]
                for c in row:
                    c.alignment = Alignment(vertical='top', wrap_text=True); c.border = BD
                if warn_col is not None and r[warn_col]:
                    row[warn_col].fill = WARN
                if abn_col is not None and r[abn_col]:
                    for c in row: c.fill = ABN
            for i, w in enumerate(widths):
                ws.column_dimensions[get_column_letter(i + 1)].width = w
            ws.freeze_panes = 'A2'

        ws = wb.active; ws.title = '时间线'
        sheet(ws, ['日期', '病程', '时间', '类别', '具体内容（原话/原值）', '来源', '备注 / 待核实'],
              [(r['date'], day(r['date']), r.get('time', ''), r.get('type', ''), r['text'], r.get('source', ''), r.get('note', '')) for r in T],
              [12, 8, 12, 10, 70, 22, 30], warn_col=6)
        sheet(wb.create_sheet('用药与治疗'), ['药物 / 治疗', '时间', '用法', '来源', '备注'],
              [(m['name'], m.get('when', ''), m.get('how', ''), m.get('source', ''), m.get('note', '')) for m in meds], [34, 18, 22, 16, 30], warn_col=4)
        sheet(wb.create_sheet('检验明细'), ['日期', '报告', '项目', '结果', '单位', '参考范围', '异常'],
              [(x['date'], x.get('report', ''), x['item'], x['value'], x.get('unit', ''), x.get('ref', ''), x.get('flag', '')) for x in labs],
              [12, 22, 28, 12, 12, 14, 6], abn_col=6)
        sheet(wb.create_sheet('待核实'), ['事项', '说明'], [tuple(x) for x in todo], [18, 90])
        xlsx = os.path.join(outdir, f'{name}_病程事实时间线_{stamp}.xlsx'); wb.save(xlsx)

    # ---------- 时间线 PDF（前面附沟通单） ----------
    tr = lambda cells, cls='': f'<tr class="{cls}">' + ''.join(f'<td>{c}</td>' for c in cells) + '</tr>'
    rows, last = [], None
    for r in T:
        if r['date'] != last:
            rows.append(f'<tr class="day"><td colspan="5">{e(r["date"])}　{day(r["date"])}</td></tr>'); last = r['date']
        rows.append(tr([e(r.get('time', '')), e(r.get('type', '')), md(r['text']), e(r.get('source', '')),
                        f'<span class="w">{e(r["note"])}</span>' if r.get('note') else '']))
    body = f'<div>{one}</div><div class="pb"></div><h1>{e(name)} · {e(P.get("title", "病程事实时间线"))}</h1>'
    body += f'<div class="sub">整理日期 {e(today)}' + (f'　|　病程自 {e(P["onset"])} 起' if onset else '') + '<br>只列事实，原话用「」保留，不含分析结论。</div>'
    if d.get('summary_alert'):
        body += f'<div class="red">{md(d["summary_alert"])}</div>'
    if bg:
        body += '<h2>基本情况</h2><table class="label">' + ''.join(tr([e(a), md(b)]) for a, b in bg) + '</table>'
    body += ('<h2>时间线</h2><table><thead><tr><th style="width:52px">时间</th><th style="width:48px">类别</th><th>具体内容（原话 / 原值）</th>'
             '<th style="width:100px">来源</th><th style="width:110px">备注</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table>')
    if meds:
        body += ('<h2>用药与治疗</h2><table><thead><tr><th>药物 / 治疗</th><th style="width:90px">时间</th><th style="width:110px">用法</th><th style="width:80px">来源</th><th style="width:120px">备注</th></tr></thead><tbody>'
                 + ''.join(tr([e(m['name']), e(m.get('when', '')), e(m.get('how', '')), e(m.get('source', '')), f'<span class="w">{e(m.get("note", ""))}</span>']) for m in meds) + '</tbody></table>')
    if todo:
        body += '<h2>待核实</h2><table><tbody>' + ''.join(tr([f'<b>{e(a)}</b>', md(b)]) for a, b in todo) + '</tbody></table>'
    if labs:
        body += ('<h2>附：检验明细（异常项标红）</h2><table><thead><tr><th style="width:70px">日期</th><th style="width:100px">报告</th><th>项目</th><th style="width:60px">结果</th><th style="width:60px">单位</th><th style="width:70px">参考范围</th><th style="width:22px"></th></tr></thead><tbody>'
                 + ''.join(tr([e(x['date']), e(x.get('report', '')), e(x['item']), f'<b>{e(x["value"])}</b>' if x.get('flag') else e(x['value']),
                               e(x.get('unit', '')), e(x.get('ref', '')), e(x.get('flag', ''))], 'abn' if x.get('flag') else '') for x in labs) + '</tbody></table>')
    page = lambda b: f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>{BASE_CSS}</style></head><body>{b}</body></html>'
    out = []
    pdf = os.path.join(outdir, f'{name}_病程事实时间线_{stamp}.pdf')
    if to_pdf(page(body), pdf, browser): out.append(pdf)
    pdf1 = os.path.join(outdir, f'{name}_就诊沟通单_{stamp}.pdf')
    if to_pdf(page(one), pdf1, browser): out.append(pdf1)

    # ---------- 动态血糖汇总（可选） ----------
    C = d.get('cgm')
    if C:
        head = ['时间段', '平均血糖 (mmol/L)', '3.9–10 时间', '高于 10', '低于 3.9']
        cb = f'<div class="page"><h1>动态血糖汇总</h1><div class="meta">{who}　｜　家属整理于 {e(today)}</div>'
        cb += '<table><thead><tr>' + ''.join(f'<th>{h}</th>' for h in head) + '</tr></thead><tbody>' + ''.join(tr([e(str(c)) for c in r]) for r in C.get('rows', [])) + '</tbody></table>'
        if C.get('summary'):
            cb += f'<div class="key">{md(C["summary"])}</div>'
        if C.get('targets'):
            cb += '<h3>目标（请医生确认）</h3><table><thead><tr><th>指标</th><th>目标</th><th>现在</th></tr></thead><tbody>' + ''.join(tr([e(str(c)) for c in r]) for r in C['targets']) + '</tbody></table>'
        cb += '</div>'
        for sec in C.get('images', []):
            files = [os.path.join(base, f) for f in sec.get('files', [])]
            files = [f for f in files if os.path.exists(f)]
            if not files:
                continue
            cls = 'pair' if len(files) > 1 else 'wide'
            tags = ''.join(f'<img src="file:///{f.replace(chr(92), "/").lstrip("/")}">' for f in files)
            cb += f'<div class="page"><h2>{e(sec.get("title", ""))}</h2><div class="sub">{md(sec.get("desc", ""))}</div><div class="{cls}">{tags}</div></div>'
        pdf2 = os.path.join(outdir, f'{name}_动态血糖汇总_{stamp}.pdf')
        if to_pdf(page(cb), pdf2, browser): out.append(pdf2)

    if xlsx: out.append(xlsx)
    else: print('（未安装 openpyxl，跳过 Excel：pip install openpyxl）')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
