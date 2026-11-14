"""Builds tests/fixtures/arabic.docx (task 8.2): headings, right-to-left paragraphs and a table."""

from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement


def rtl(paragraph):
    p_pr = paragraph._p.get_or_add_pPr()
    bidi = OxmlElement("w:bidi")
    bidi.set(qn("w:val"), "1")
    p_pr.append(bidi)
    return paragraph


doc = Document()
rtl(doc.add_heading("سياسة الخصوصية", level=1))
rtl(doc.add_paragraph("نحترم خصوصية عملائنا ولا نشارك بياناتهم مع أي طرف ثالث دون موافقتهم."))
rtl(doc.add_heading("البيانات التي نجمعها", level=2))
rtl(doc.add_paragraph("نجمع الاسم ورقم الهاتف وعنوان التوصيل فقط لإتمام الطلب."))
rtl(doc.add_heading("مدة الاحتفاظ", level=2))
rtl(doc.add_paragraph("نحتفظ بالبيانات لمدة سنتين ثم نحذفها تلقائيًا."))
table = doc.add_table(rows=3, cols=2)
for r, (k, v) in enumerate([("نوع البيان", "مدة الاحتفاظ"), ("رقم الهاتف", "سنتان"), ("عنوان التوصيل", "سنة واحدة")]):
    table.cell(r, 0).text = k
    table.cell(r, 1).text = v
doc.save(Path(__file__).with_name("arabic.docx"))
