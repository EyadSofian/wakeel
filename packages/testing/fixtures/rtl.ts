/**
 * Right-to-left and mixed-direction fixtures (design system §6, CLAUDE.md §11). Every content surface
 * is screenshotted with the first seven; retrieval, input, truncation and eval changes are checked
 * against all of them.
 *
 * `direction` is what `dir="auto"` resolves to: the direction of the first strong character.
 */
export interface RtlFixture {
  id: string;
  label: string;
  text: string;
  direction: "rtl" | "ltr";
}

/** Design system §6: must appear in screenshots of every content surface. */
export const SCREENSHOT_FIXTURES: readonly RtlFixture[] = [
  { id: "pure_arabic", label: "Pure Arabic", direction: "rtl", text: "مرحبا بك في متجر النور، كيف أقدر أساعدك اليوم؟" },
  {
    id: "arabic_product_code",
    label: "Arabic with an English product code",
    direction: "rtl",
    text: "طلبك رقم ORD-2026-45123 خرج للشحن وسيصل خلال يومين.",
  },
  {
    id: "english_arabic_name",
    label: "English with an Arabic name",
    direction: "ltr",
    text: "Order confirmed for محمد عبد الرحمن, delivery tomorrow before 6 pm.",
  },
  {
    id: "arabic_url",
    label: "Arabic with a URL",
    direction: "rtl",
    text: "تقدر تتابع شحنتك من هنا: https://track.example.com/orders/45123?lang=ar ثم اضغط تحديث.",
  },
  {
    id: "long_token",
    label: "A long unbroken token",
    direction: "rtl",
    text: `رقم المرجع: ${"X7Q9".repeat(30)}`,
  },
  {
    id: "arabic_diacritics",
    label: "Arabic with diacritics",
    direction: "rtl",
    text: "السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللَّهِ وَبَرَكَاتُهُ",
  },
  { id: "emoji", label: "Arabic with an emoji", direction: "rtl", text: "تم استلام طلبك 🎉 شكراً لاختيارك متجرنا 🙏🏽" },
];

/** CLAUDE.md §11: dialects, code-switching and digits that retrieval and evals must handle. */
export const LANGUAGE_FIXTURES: readonly RtlFixture[] = [
  { id: "egyptian", label: "Egyptian dialect", direction: "rtl", text: "ازيك، عايز أعرف الأوردر بتاعي هيوصل امتى؟" },
  { id: "gulf", label: "Gulf dialect", direction: "rtl", text: "شلونك؟ أبي أعرف وين وصل طلبي، صار له أسبوع." },
  {
    id: "code_switch",
    label: "Arabic–English code-switching",
    direction: "rtl",
    text: "ممكن تبعتلي الـ invoice على الإيميل please؟ محتاجها للـ accounting.",
  },
  {
    id: "arabic_indic_digits",
    label: "Arabic-Indic digits",
    direction: "rtl",
    text: "رقم الطلب ٤٥١٢٣ بتاريخ ١٣/١١/٢٠٢٦ والمبلغ ٢٥٠ جنيه.",
  },
  {
    id: "english_only",
    label: "English only (control)",
    direction: "ltr",
    text: "Where is my order? It has been a week.",
  },
];

export const RTL_FIXTURES: readonly RtlFixture[] = [...SCREENSHOT_FIXTURES, ...LANGUAGE_FIXTURES];

/**
 * The direction `dir="auto"` would pick: that of the first strong character (Unicode bidi rules
 * P2–P3, simplified to Arabic and Hebrew letters versus Latin letters). Neutral-only text is "ltr".
 */
export function firstStrongDirection(text: string): "rtl" | "ltr" {
  for (const ch of text) {
    if (/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(ch) && /\p{L}/u.test(ch)) return "rtl";
    if (/\p{L}/u.test(ch)) return "ltr";
  }
  return "ltr";
}
