'use strict';
// 离线 Office 预览 / 编辑（免 CDN）：
// 预览用已安装的 yauzl 解开 docx/xlsx 的 ZIP 容器，提取文本/表格并以 HTML 返回（只读）。
// 编辑借助成熟库：SheetJS(xlsx) 读写电子表格、mammoth 读 docx→HTML、html-docx-js 把 HTML 写回 docx。
const yauzl = require('yauzl');
const fs = require('fs');

function unzipPick(file, names) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = {};
      let remaining = names.length;
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        if (names.includes(entry.fileName)) {
          zip.openReadStream(entry, (e2, stream) => {
            if (e2) return reject(e2);
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.on('error', reject);
            stream.on('end', () => {
              out[entry.fileName] = Buffer.concat(chunks);
              remaining--;
              if (remaining <= 0) { zip.close(); resolve(out); }
              else zip.readEntry();
            });
          });
        } else {
          if (remaining > 0) zip.readEntry();
          else { zip.close(); resolve(out); }
        }
      });
      zip.on('end', () => resolve(out));
      zip.readEntry();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// 提取 docx 正文文本（按段落）
function docxToHtml(buf) {
  const xml = buf.toString('utf8');
  const paras = xml.split(/<\/w:p>/i);
  const lines = paras.map((p) => {
    const texts = [];
    const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/gi;
    let m;
    while ((m = re.exec(p))) texts.push(m[1]);
    return texts.join('');
  }).filter((l) => l.trim().length || true);
  return '<div class="office-doc">' + lines.map((l) => '<p>' + escapeHtml(l) + '</p>').join('') + '</div>';
}

// 提取 xlsx 为 HTML 表格
function xlsxToHtml(parts) {
  let strings = [];
  if (parts['xl/sharedStrings.xml']) {
    const xml = parts['xl/sharedStrings.xml'].toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/gi;
    let m;
    while ((m = re.exec(xml))) {
      const tr = /<t[^>]*>([\s\S]*?)<\/t>/gi;
      let mm, s = '';
      while ((mm = tr.exec(m[1]))) s += mm[1];
      strings.push(s);
    }
  }
  const sheet = parts['xl/worksheets/sheet1.xml'];
  if (!sheet) return '<div class="office-doc"><p class="hint">（无可预览的工作表）</p></div>';
  const xml = sheet.toString('utf8');
  const cellRe = /<c([^>]*)>(\s*<(?:v|f)>([\s\S]*?)<\/(?:v|f)>\s*)?<\/c>/gi;
  const cells = {};
  let maxCol = 0, maxRow = 0;
  let m;
  while ((m = cellRe.exec(xml))) {
    const attrs = m[1];
    const ref = /r="([A-Z]+\d+)"/i.exec(attrs);
    if (!ref) continue;
    const r = ref[1];
    const colLetters = r.match(/[A-Z]+/)[0];
    const row = parseInt(r.match(/\d+/)[0], 10);
    let col = 0; for (let i = 0; i < colLetters.length; i++) col = col * 26 + (colLetters.charCodeAt(i) - 64);
    const isStr = /t="s"/i.test(attrs);
    let val = m[3] || '';
    if (isStr) { const idx = parseInt(val, 10); val = strings[idx] != null ? strings[idx] : ''; }
    cells[r] = val;
    if (col > maxCol) maxCol = col;
    if (row > maxRow) maxRow = row;
  }
  if (maxRow === 0 || maxCol === 0) return '<div class="office-doc"><p class="hint">（空工作表）</p></div>';
  const colName = (n) => { let s = ''; while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
  let html = '<div class="office-doc"><table class="office-table">';
  for (let r = 1; r <= maxRow; r++) {
    html += '<tr>';
    for (let c = 1; c <= maxCol; c++) {
      const v = escapeHtml(cells[colName(c) + r] || '');
      html += (r === 1 ? '<th>' : '<td>') + v + (r === 1 ? '</th>' : '</td>');
    }
    html += '</tr>';
  }
  html += '</table></div>';
  return html;
}

async function preview(abs, kind) {
  if (kind === 'docx') {
    const parts = await unzipPick(abs, ['word/document.xml']);
    if (!parts['word/document.xml']) throw new Error('无法读取 document.xml');
    return { kind: 'docx', html: docxToHtml(parts['word/document.xml']) };
  } else if (kind === 'xlsx') {
    const parts = await unzipPick(abs, ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);
    return { kind: 'xlsx', html: xlsxToHtml(parts) };
  }
  throw new Error('UNSUPPORTED');
}

// ================= 编辑：Excel =================
// 网格上限：防止超大 / 被整列格式化的工作表把浏览器卡死（此前 xlsm 打开一直“加载中”即此原因）
const MAX_EXCEL_ROWS = 500;
const MAX_EXCEL_COLS = 60;

// 读取为 { sheets:[{name, rows, cols, merges, totalRows, totalCols}] }；公式以 "=" 开头呈现，其余为显示值。
// opts.preview=true 时跳过 cellStyles（预览不需要，可显著加快读取）
async function excelRead(abs, opts) {
  opts = opts || {};
  const XLSX = require('xlsx');
  const buf = fs.readFileSync(abs);
  const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellStyles: !opts.preview, cellDates: true });
  let truncated = false;
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows = [];
    const ref = ws && ws['!ref'];
    let totalRows = 0, totalCols = 0;
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      // 钳制范围，避免 !ref 巨大（如整列套用格式）导致迭代上亿单元格、浏览器卡死
      const eR = Math.min(range.e.r, MAX_EXCEL_ROWS - 1);
      const eC = Math.min(range.e.c, MAX_EXCEL_COLS - 1);
      if (range.e.r > eR || range.e.c > eC) truncated = true;
      totalRows = range.e.r + 1; totalCols = range.e.c + 1;
      for (let r = range.s.r; r <= eR; r++) {
        const row = [];
        for (let c = range.s.c; c <= eC; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          let val = '';
          if (cell) {
            if (cell.f) val = '=' + cell.f;
            else if (cell.w != null) val = cell.w;
            else if (cell.v != null) val = (cell.t === 'd' && cell.v instanceof Date) ? cell.v.toISOString() : String(cell.v);
          }
          row.push(val);
        }
        rows.push(row);
      }
    }
    // 列宽（像素）：优先 wpx，否则由 wch 估算
    const cols = (ws['!cols'] || []).map((c) => (c && c.wpx != null ? Math.round(c.wpx) : (c && c.wch != null ? Math.round(c.wch * 7) : 72)));
    // 合并区域（0 基，含端点）：{r1,c1,r2,c2}
    const merges = (ws['!merges'] || []).map((m) => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }));
    return { name, rows, cols, merges, totalRows, totalCols };
  });
  return { sheets, truncated };
}

// 写回：以 sheets 数组为准整体重建工作簿（支持新建/重命名/删除工作表），
// 优先采用前端传入的列宽(cols,像素)与合并(merges)，否则继承旧表；公式以 "=" 开头。
async function excelWrite(abs, sheets, bookType) {
  const XLSX = require('xlsx');
  let oldWb = null;
  try { oldWb = XLSX.read(fs.readFileSync(abs), { type: 'buffer', cellFormula: true, cellStyles: true }); }
  catch (e) { oldWb = null; }
  const wb = XLSX.utils.book_new();
  (sheets || []).forEach((s) => {
    const rows = (s.rows || []).map((row) => (row || []).map((cell) => {
      const raw = (cell == null ? '' : String(cell)).trim();
      if (raw.startsWith('=')) return { f: raw.slice(1) };       // 公式
      if (raw === '') return '';                                  // 空
      if (!isNaN(Number(raw))) return Number(raw);                // 数字
      return raw;                                                 // 文本
    }));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const old = oldWb && oldWb.Sheets[s.name];
    // 列宽：优先前端传入，否则继承旧表
    if (Array.isArray(s.cols) && s.cols.some((c) => c != null && Number(c) > 0)) {
      ws['!cols'] = s.cols.map((c) => ({ wpx: (c != null && Number(c) > 0) ? Number(c) : 72 }));
    } else if (old && old['!cols']) ws['!cols'] = old['!cols'];
    // 合并：优先前端传入（0 基 {r1,c1,r2,c2}），否则继承旧表
    if (Array.isArray(s.merges) && s.merges.length) {
      ws['!merges'] = s.merges.map((m) => ({ s: { r: m.r1, c: m.c1 }, e: { r: m.r2, c: m.c2 } }));
    } else if (old && old['!merges']) ws['!merges'] = old['!merges'];
    if (old && old['!rows']) ws['!rows'] = old['!rows'];
    XLSX.utils.book_append_sheet(wb, ws, s.name, true);
  });
  const bt = (bookType && ['xlsx', 'xlsm', 'xltx', 'xltm'].includes(bookType)) ? bookType : 'xlsx';
  const out = XLSX.write(wb, { type: 'buffer', bookType: bt, cellStyles: true });
  fs.writeFileSync(abs, out);
  return { ok: true };
}

// 新建空白工作簿（含一个可用的 Sheet1）。
async function createExcel(abs) {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1', true);
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(abs, out);
  return { ok: true };
}

// ================= 编辑：Word =================
// docx → HTML（图片内联为 base64，便于回写时保留）。
async function wordRead(abs) {
  const mammoth = require('mammoth');
  const buf = fs.readFileSync(abs);
  const opts = {
    convertImage: mammoth.images.imgElement((img) =>
      img.readAsBase64String().then((b64) => ({ src: 'data:' + img.contentType + ';base64,' + b64 })))
  };
  const result = await mammoth.convertToHtml({ buffer: buf }, opts);
  return { html: result.value };
}

// HTML → docx 写回（html-to-docx 生成真正内联文本的 OOXML，mammoth 可回读，往返成立）。
async function wordWrite(abs, html) {
  const htmlToDocx = require('html-to-docx');
  const buf = await htmlToDocx(html, null, {});
  fs.writeFileSync(abs, buf);
  return { ok: true };
}

// 新建空白 Word：用 html-to-docx 生成含一个空段落的真正 docx（mammoth 可回读，避免 altChunk 老路径）。
async function createWord(abs) {
  const htmlToDocx = require('html-to-docx');
  const buf = await htmlToDocx('<p></p>', null, {});
  fs.writeFileSync(abs, buf);
  return { ok: true };
}

module.exports = { preview, excelRead, excelWrite, createExcel, wordRead, wordWrite, createWord };
