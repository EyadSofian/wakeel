import { ACADEMY, type Course, courses } from "./catalogue";

/**
 * Renders each course as one long Markdown page, the way a course website is written: overview
 * paragraphs, a modules table, a cohorts table, a price table, and an FAQ. The real chunker splits
 * these pages, so the set measures chunking as well as search. Numbers are written without
 * thousands separators so an answer string is matched exactly.
 */

export const installment = (c: Course) => Math.round(c.price / c.installments);
export const earlyPrice = (c: Course) => Math.round(c.price * (1 - c.earlyDiscount / 100));

function overview(c: Course): string {
  return [
    `## نظرة عامة على كورس ${c.ar}`,
    "",
    `كورس ${c.ar} (${c.en}) من برامج ${ACADEMY} في مجال ${c.field}. يقدم الكورس ${c.instructor}، ${c.instructorBio}. ` +
      `يمتد الكورس ${c.weeks} أسابيع بإجمالي ${c.hours} ساعة تدريبية، ولغة الشرح ${c.language}.`,
    "",
    `يعتمد الكورس على التطبيق العملي من أول محاضرة؛ كل وحدة تنتهي بتمرين على مشروع حقيقي، وتستخدم فيه برامج ${c.software}. ` +
      "المحاضرات المباشرة تسجل وترفع على منصة الأكاديمية خلال 24 ساعة من انتهاء المحاضرة، ويمكن طرح الأسئلة في مجموعة الدفعة طوال مدة الكورس.",
    "",
    "يناسب الكورس حديثي التخرج الذين يريدون دخول سوق العمل بمهارة تطبيقية واضحة، كما يناسب المهندسين العاملين الذين يريدون تنظيم خبرتهم العملية على أسس علمية. " +
      "لا تعتمد الأكاديمية على الحفظ النظري؛ التقييم يتم على المشروع النهائي وعلى التمارين الأسبوعية.",
  ].join("\n");
}

function modules(c: Course): string {
  const rows = c.modules.map((m, i) => `| ${i + 1} | ${m.name} | ${m.hours} ساعات |`);
  return [
    `## المحتوى التفصيلي لكورس ${c.ar}`,
    "",
    `ينقسم كورس ${c.ar} إلى ${c.modules.length} وحدات، وكل وحدة لها تمرين تطبيقي يسلم قبل الوحدة التالية.`,
    "",
    "| رقم الوحدة | اسم الوحدة | عدد الساعات |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "يحصل المتدرب على ملف المحاضرة وملفات التمارين بعد كل وحدة، ويتم تصحيح التمارين وإرسال الملاحظات خلال أسبوع.",
  ].join("\n");
}

function cohorts(c: Course): string {
  const rows = c.cohorts.map((k) => `| ${k.label} | ${k.start} | ${k.days} | ${k.time} | ${k.mode} |`);
  return [
    `## مواعيد دفعات كورس ${c.ar}`,
    "",
    "| الدفعة | تاريخ البداية | أيام المحاضرات | وقت المحاضرة | طريقة الحضور |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "المواعيد بتوقيت القاهرة. يمكن نقل الحجز إلى دفعة لاحقة مرة واحدة قبل بداية الدفعة بأسبوع على الأقل.",
  ].join("\n");
}

function prices(c: Course): string {
  return [
    `## سعر كورس ${c.ar} وطرق الدفع`,
    "",
    "| البند | القيمة |",
    "| --- | --- |",
    `| سعر الكورس كاملًا | ${c.price} جنيه |`,
    `| عدد الأقساط المتاحة | ${c.installments} أقساط شهرية |`,
    `| قيمة القسط الشهري | ${installment(c)} جنيه |`,
    `| خصم الحجز المبكر | ${c.earlyDiscount}% قبل بداية الدفعة بأسبوعين |`,
    `| السعر بعد خصم الحجز المبكر | ${earlyPrice(c)} جنيه |`,
    "",
    "يتم الدفع بالبطاقة البنكية أو المحافظ الإلكترونية أو التحويل البنكي. القسط الأول يدفع عند الحجز، وباقي الأقساط في نفس اليوم من كل شهر بدون فوائد.",
  ].join("\n");
}

function projectAndCertificate(c: Course): string {
  return [
    `## المشروع النهائي والشهادة في كورس ${c.ar}`,
    "",
    `المشروع النهائي: ${c.project}. يسلم المشروع خلال أسبوعين من آخر محاضرة، ويناقش في جلسة فردية مدتها نصف ساعة.`,
    "",
    `الشهادة: ${c.certificate}. تصدر الشهادة بعد قبول المشروع وحضور 75% من المحاضرات على الأقل.`,
    "",
    `تبقى تسجيلات كورس ${c.ar} متاحة لمدة ${c.recordingsDays} يومًا من تاريخ آخر محاضرة.`,
  ].join("\n");
}

function requirements(c: Course): string {
  return [
    `## المتطلبات قبل الالتحاق بكورس ${c.ar}`,
    "",
    `المتطلب الأساسي: ${c.requirement}. يحتاج المتدرب جهاز لابتوب عليه البرامج المطلوبة، وترسل الأكاديمية دليل التثبيت قبل بداية الدفعة بأسبوع.`,
  ].join("\n");
}

function faq(c: Course): string {
  return [
    `## الأسئلة الشائعة عن كورس ${c.ar}`,
    "",
    `### ${c.faqQuestion}`,
    "",
    c.faqAnswer,
    "",
    "### ماذا لو فاتتني محاضرة؟",
    "",
    "يمكن مشاهدة التسجيل، لكن الحضور يحسب من المحاضرات المباشرة فقط، والحد الأدنى للحصول على الشهادة 75%.",
    "",
    "### هل يمكن استرداد الرسوم؟",
    "",
    "يمكن استرداد الرسوم كاملة قبل بداية الدفعة، وبعد أول محاضرة يسترد نصف المبلغ فقط إذا قدم الطلب خلال 7 أيام.",
  ].join("\n");
}

export interface Page {
  key: string;
  title: string;
  uri: string;
  markdown: string;
}

export const pages: Page[] = courses.map((c) => ({
  key: c.code,
  title: `${c.ar} — ${c.en}`,
  uri: `https://example.test/courses/${c.code.toLowerCase()}`,
  markdown: [
    `# ${c.ar} (${c.en})`,
    overview(c),
    modules(c),
    cohorts(c),
    prices(c),
    projectAndCertificate(c),
    requirements(c),
    faq(c),
  ].join("\n\n"),
}));
