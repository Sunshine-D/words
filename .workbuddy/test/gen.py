# -*- coding: utf-8 -*-
"""生成用于解析器验证的 docx / xlsx / pdf 样本"""
import os, zipfile, zlib, io

OUT = os.path.dirname(os.path.abspath(__file__))

WORDS = [
    ("personal", "adj. 私人的"),
    ("tie", "v. 系，联系"),
    ("still", "adj. 静止的；adv. 甚至，仍然"),
    ("offer", "v. 提供"),
    ("addition", "n. 增加"),
    ("success", "n. 成功"),
    ("produce", "v. 生产，引起"),
    ("expect", "v. 预料，期待"),
]

# ---------------- docx ----------------
def make_docx(path):
    paragraphs = []
    for i, (en, cn) in enumerate(WORDS, 1):
        paragraphs.append(
            '<w:p><w:r><w:t>%d. </w:t></w:r><w:r><w:t>%s</w:t></w:r>'
            '<w:r><w:tab/><w:t>%s</w:t></w:r></w:p>' % (i, en, cn)
        )
    # 再追加一个两列表格形式的词条，验证表格解析
    table_rows = ""
    for en, cn in [("valuable", "adj. 贵重的"), ("protect", "v. 保护")]:
        table_rows += (
            '<w:tr><w:tc><w:p><w:r><w:t>%s</w:t></w:r></w:p></w:tc>'
            '<w:tc><w:p><w:r><w:t>%s</w:t></w:r></w:p></w:tc></w:tr>' % (en, cn)
        )
    table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Word</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Meaning</w:t></w:r></w:p></w:tc></w:tr>%s</w:tbl>' % table_rows

    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body>' + "".join(paragraphs) + table + '</w:body></w:document>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types.encode("utf-8"))
        z.writestr("_rels/.rels", rels.encode("utf-8"))
        z.writestr("word/document.xml", document.encode("utf-8"))
    print("docx ->", path)


# ---------------- xlsx ----------------
def make_xlsx(path):
    strings = ["单词", "中文释义"]
    cells = []
    for en, cn in WORDS:
        strings.extend([en, cn])
    total = len(strings)
    idx = 2
    rows = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    for r, (en, cn) in enumerate(WORDS, start=2):
        rows += '<row r="%d"><c r="A%d" t="s"><v>%d</v></c><c r="B%d" t="s"><v>%d</v></c></row>' % (
            r, r, idx, r, idx + 1)
        idx += 2

    sst = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">' % (total, total)
        + "".join('<si><t xml:space="preserve">%s</t></si>' % s for s in strings)
        + '</sst>'
    )
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData>' + rows + '</sheetData></worksheet>'
    )
    wb = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
        '</Relationships>'
    )
    ct = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '</Relationships>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct.encode("utf-8"))
        z.writestr("_rels/.rels", rels.encode("utf-8"))
        z.writestr("xl/workbook.xml", wb.encode("utf-8"))
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels.encode("utf-8"))
        z.writestr("xl/sharedStrings.xml", sst.encode("utf-8"))
        z.writestr("xl/worksheets/sheet1.xml", sheet.encode("utf-8"))
    print("xlsx ->", path)


# ---------------- pdf ----------------
def make_pdf(path):
    lines = []
    y = 760
    for en, cn in WORDS:
        hexcn = cn.encode("utf-16-be").hex().upper()
        # 英文与中文用两个 BT 块绘制，模拟真实 PDF 的混排
        lines.append("BT /F1 11 Tf 60 %d Td (%s) Tj ET" % (y, en))
        lines.append("BT /F2 11 Tf 200 %d Td <%s> Tj ET" % (y, hexcn))
        y -= 26
    content = "\n".join(lines).encode("latin-1")
    comp = zlib.compress(content)

    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>"
    )
    objs.append(b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(comp) + comp + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>")

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = [0]
    for i, body in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i)
        out.write(body)
        out.write(b"\nendobj\n")
    xref_pos = out.tell()
    n = len(objs) + 1
    out.write(b"xref\n0 %d\n" % n)
    out.write(b"0000000000 65535 f \n")
    for off in offsets[1:]:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (n, xref_pos))
    with open(path, "wb") as f:
        f.write(out.getvalue())
    print("pdf ->", path)


# ---------------- txt ----------------
def make_txt(path):
    lines = []
    for i, (en, cn) in enumerate(WORDS, 1):
        lines.append("%d. %s  /pron/  %s" % (i, en, cn))
    lines.append("")
    lines.append("页眉残留")
    lines.append("123")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("txt ->", path)


if __name__ == "__main__":
    make_docx(os.path.join(OUT, "sample.docx"))
    make_xlsx(os.path.join(OUT, "sample.xlsx"))
    make_pdf(os.path.join(OUT, "sample.pdf"))
    make_txt(os.path.join(OUT, "sample.txt"))
