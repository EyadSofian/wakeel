/**
 * Builds the parser fixtures (task 8.2) from HTML with Chromium, so Arabic shaping and right-to-left
 * order are what a real born-digital PDF has. Run `pnpm --filter @wakeel/parser fixtures`, then
 * `uv run python tests/fixtures/generate_docx.py`. The outputs are committed; tests never generate.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const out = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

const page = (body: string) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>body{font-family:"Geeza Pro","Noto Naskh Arabic","Arial",sans-serif;font-size:16px;line-height:1.7;margin:48px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #444;padding:6px 10px;text-align:right}
thead{display:table-header-group}h1{font-size:28px}h2{font-size:21px}</style></head><body>${body}</body></html>`;

const bornDigital = page(`
<h1>دليل خدمة العملاء</h1>
<p>يشرح هذا الدليل سياسة الاسترجاع والشحن لمتجرنا. نرجو قراءة الشروط قبل تقديم أي طلب.</p>
<h2>سياسة الاسترجاع</h2>
<p>يمكن استرجاع المنتج خلال ١٤ يومًا من تاريخ الاستلام بشرط أن يكون في عبوته الأصلية.</p>
<p>لا تُسترجع المنتجات المخفّضة إلا إذا وصلت تالفة.</p>
<h2>الشحن والتوصيل</h2>
<p>يصل الطلب داخل القاهرة خلال يومين، وإلى باقي المحافظات خلال ٣ إلى ٥ أيام عمل.</p>
<p>تكلفة الشحن ٥٠ جنيهًا، ومجانية للطلبات التي تزيد على ١٠٠٠ جنيه.</p>`);

const rows = Array.from(
  { length: 60 },
  (_, i) =>
    `<tr><td>منتج رقم ${i + 1}</td><td>${(i + 1) * 25} جنيه</td><td>${i % 3 === 0 ? "متوفر" : "غير متوفر"}</td></tr>`,
).join("");
const tableAcrossPages = page(`
<h1>قائمة الأسعار</h1>
<p>الأسعار شاملة ضريبة القيمة المضافة.</p>
<table><thead><tr><th>المنتج</th><th>السعر</th><th>الحالة</th></tr></thead><tbody>${rows}</tbody></table>`);

const scan = page(`
<h1>إيصال استلام</h1>
<p>استلمت أنا الموقّع أدناه مبلغ ألف وخمسمائة جنيه نقدًا قيمة الدفعة الأولى من عقد التوريد.</p>
<p>تحريرًا في القاهرة بتاريخ العاشر من نوفمبر.</p>`);

const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  await tab.setContent(bornDigital);
  writeFileSync(out("arabic-born-digital.pdf"), await tab.pdf({ format: "A4" }));
  await tab.setContent(tableAcrossPages);
  writeFileSync(out("table-page-break.pdf"), await tab.pdf({ format: "A4" }));

  // A scan: the page as pixels only, slightly rotated like a sheet on a scanner, no text layer.
  await tab.setContent(scan);
  const png = await tab.screenshot({ fullPage: false });
  writeFileSync(out("scanned-arabic.png"), png);
  const img = `data:image/png;base64,${png.toString("base64")}`;
  await tab.setContent(
    `<!doctype html><html><body style="margin:0"><img src="${img}" style="width:100%;transform:rotate(0.6deg)"></body></html>`,
  );
  writeFileSync(out("scanned-arabic.pdf"), await tab.pdf({ format: "A4", printBackground: true }));
} finally {
  await browser.close();
}
