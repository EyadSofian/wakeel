import { type Course, courses } from "./catalogue";
import { earlyPrice, installment } from "./pages";

/**
 * The realistic set's 200 questions (task 8.9, ADR-056), authored as templates per locale and
 * instantiated over the catalogue. Each answerable question names its course and the exact answer
 * text; its relevant chunks are the chunks of that course's page that contain the answer. All
 * judgments are fixed here, before any model runs.
 */

export const LOCALES = ["msa", "egyptian", "gulf", "code-switched"] as const;
export type Locale = (typeof LOCALES)[number];
export const SLICES = ["single", "follow-up", "table", "near-miss", "unanswerable"] as const;
export type Slice = (typeof SLICES)[number];

export interface Question {
  key: string;
  slice: Slice;
  locale: Locale;
  query: string;
  /** Earlier turns a follow-up depends on; the query alone does not name the course. */
  history?: { user: string; assistant: string };
  /** The course whose page answers it; absent for unanswerable questions. */
  course?: string;
  /** Text a relevant chunk must contain (compared after Arabic normalisation). */
  answer?: string;
}

type Template = { [L in Locale]: (c: Course) => string };
interface Fact {
  name: string;
  answer: (c: Course) => string;
  ask: Template;
}

const by = (code: string) => {
  const c = courses.find((x) => x.code === code);
  if (!c) throw new Error(`unknown course ${code}`);
  return c;
};

/** Facts stated in a page's prose. */
const prose: Fact[] = [
  {
    name: "instructor",
    answer: (c) => c.instructor,
    ask: {
      msa: (c) => `من يقدم كورس ${c.ar}؟`,
      egyptian: (c) => `مين اللي بيشرح كورس ${c.ar}؟`,
      gulf: (c) => `منو اللي يدرّس دورة ${c.ar}؟`,
      "code-switched": (c) => `مين الـ instructor بتاع كورس ${c.en}؟`,
    },
  },
  {
    name: "project",
    answer: (c) => c.project,
    ask: {
      msa: (c) => `ما المشروع النهائي في كورس ${c.ar}؟`,
      egyptian: (c) => `المشروع النهائي في كورس ${c.ar} عبارة عن إيه؟`,
      gulf: (c) => `وش المشروع النهائي في دورة ${c.ar}؟`,
      "code-switched": (c) => `الـ final project في كورس ${c.en} بيكون إيه؟`,
    },
  },
  {
    name: "requirement",
    answer: (c) => c.requirement,
    ask: {
      msa: (c) => `ما المتطلبات المسبقة للالتحاق بكورس ${c.ar}؟`,
      egyptian: (c) => `محتاج أكون عارف إيه قبل ما أدخل كورس ${c.ar}؟`,
      gulf: (c) => `وش لازم يكون عندي قبل أسجل في دورة ${c.ar}؟`,
      "code-switched": (c) => `إيه الـ prerequisites لكورس ${c.en}؟`,
    },
  },
  {
    name: "recordings",
    answer: (c) => `${c.recordingsDays} يومًا`,
    ask: {
      msa: (c) => `كم مدة إتاحة تسجيلات كورس ${c.ar}؟`,
      egyptian: (c) => `تسجيلات كورس ${c.ar} بتفضل متاحة قد إيه؟`,
      gulf: (c) => `لين متى أقدر أشوف تسجيلات دورة ${c.ar}؟`,
      "code-switched": (c) => `الـ recordings بتاعة كورس ${c.en} متاحة لمدة قد إيه؟`,
    },
  },
  {
    name: "software",
    answer: (c) => c.software,
    ask: {
      msa: (c) => `ما البرامج المستخدمة في كورس ${c.ar}؟`,
      egyptian: (c) => `كورس ${c.ar} بيشتغل على أنهي برامج؟`,
      gulf: (c) => `وش البرامج اللي نستخدمها في دورة ${c.ar}؟`,
      "code-switched": (c) => `إيه الـ software اللي بنستخدمه في كورس ${c.en}؟`,
    },
  },
];

/** Facts that live only in a page's tables. */
const tabled: Fact[] = [
  {
    name: "price",
    answer: (c) => `${c.price} جنيه`,
    ask: {
      msa: (c) => `كم سعر كورس ${c.ar}؟`,
      egyptian: (c) => `كورس ${c.ar} بكام؟`,
      gulf: (c) => `كم سعر دورة ${c.ar}؟`,
      "code-switched": (c) => `الـ price بتاع كورس ${c.en} كام؟`,
    },
  },
  {
    name: "installment",
    answer: (c) => `${installment(c)} جنيه`,
    ask: {
      msa: (c) => `كم قيمة القسط الشهري لكورس ${c.ar}؟`,
      egyptian: (c) => `القسط الشهري لكورس ${c.ar} بكام؟`,
      gulf: (c) => `كم القسط الشهري حق دورة ${c.ar}؟`,
      "code-switched": (c) => `الـ monthly installment لكورس ${c.en} كام؟`,
    },
  },
  {
    name: "start",
    answer: (c) => c.cohorts[0]?.start ?? "",
    ask: {
      msa: (c) => `متى تبدأ ${c.cohorts[0]?.label} من كورس ${c.ar}؟`,
      egyptian: (c) => `${c.cohorts[0]?.label} بتاعة كورس ${c.ar} هتبدأ إمتى؟`,
      gulf: (c) => `متى تبدا ${c.cohorts[0]?.label} لدورة ${c.ar}؟`,
      "code-switched": (c) => `الـ start date لـ${c.cohorts[0]?.label} في كورس ${c.en} إمتى؟`,
    },
  },
  {
    name: "early-price",
    answer: (c) => `${earlyPrice(c)} جنيه`,
    ask: {
      msa: (c) => `كم يصبح سعر كورس ${c.ar} بعد خصم الحجز المبكر؟`,
      egyptian: (c) => `كورس ${c.ar} يبقى بكام لو حجزت بدري؟`,
      gulf: (c) => `كم يصير سعر دورة ${c.ar} إذا حجزت بدري؟`,
      "code-switched": (c) => `سعر كورس ${c.en} بعد الـ early bird discount كام؟`,
    },
  },
];

/** A follow-up after the user asked about a course in general; it never names the course. */
const opener: Template = {
  msa: (c) => `أريد معلومات عن كورس ${c.ar}`,
  egyptian: (c) => `عايز أعرف عن كورس ${c.ar}`,
  gulf: (c) => `أبي أعرف عن دورة ${c.ar}`,
  "code-switched": (c) => `عايز details عن كورس ${c.en}`,
};
const followUps: Fact[] = [
  {
    name: "price",
    answer: (c) => `${c.price} جنيه`,
    ask: {
      msa: () => "وكم سعره؟",
      egyptian: () => "طب وبكام؟",
      gulf: () => "زين، وكم سعره؟",
      "code-switched": () => "ok والـ price كام؟",
    },
  },
  {
    name: "installments",
    answer: (c) => `${c.installments} أقساط شهرية`,
    ask: {
      msa: () => "وهل يمكن تقسيطه؟ على كم قسط؟",
      egyptian: () => "وينفع أقسطه؟ على كام قسط؟",
      gulf: () => "وأقدر أقسطه؟ على كم قسط؟",
      "code-switched": () => "وفيه installments؟ على كام قسط؟",
    },
  },
  {
    name: "start",
    answer: (c) => c.cohorts[0]?.start ?? "",
    ask: {
      msa: () => "ومتى تبدأ أول دفعة؟",
      egyptian: () => "وأول دفعة هتبدأ إمتى؟",
      gulf: () => "ومتى تبدا أول دفعة؟",
      "code-switched": () => "وأول cohort هيبدأ إمتى؟",
    },
  },
  {
    name: "requirement",
    answer: (c) => c.requirement,
    ask: {
      msa: () => "وما المتطلبات المسبقة للالتحاق به؟",
      egyptian: () => "ومحتاج إيه عشان أدخله؟",
      gulf: () => "ووش أحتاج قبل أسجل فيه؟",
      "code-switched": () => "وإيه الـ requirements بتاعته؟",
    },
  },
  {
    name: "project",
    answer: (c) => c.project,
    ask: {
      msa: () => "وما المشروع النهائي فيه؟",
      egyptian: () => "والمشروع النهائي بتاعه إيه؟",
      gulf: () => "ووش المشروع النهائي فيه؟",
      "code-switched": () => "والـ final project بتاعه إيه؟",
    },
  },
];

/** Courses whose pages look alike; a question about one must not be answered from the other. */
const PAIRS = [
  ["SRJ-REVA", "SRJ-REVM"],
  ["SRJ-CADC", "SRJ-CADM"],
  ["SRJ-ETAB", "SRJ-SAP2"],
  ["SRJ-PRIM", "SRJ-PMPX"],
  ["SRJ-HVAC", "SRJ-PLMB"],
] as const;
/** Near-miss questions name the look-alike course too, the way a customer corrects a mix-up. */
type PairTemplate = { [L in Locale]: (c: Course, other: Course) => string };
const nearMissFacts: { answer: (c: Course) => string; ask: PairTemplate }[] = [
  {
    answer: (c) => `${c.price} جنيه`,
    ask: {
      msa: (c, o) => `أقصد كورس ${c.ar} وليس ${o.ar}، كم سعره؟`,
      egyptian: (c, o) => `مش ${o.ar}، أنا قصدي ${c.ar}، سعره كام؟`,
      gulf: (c, o) => `مو ${o.ar}، أبي سعر دورة ${c.ar}`,
      "code-switched": (c, o) => `مش ${o.en}، الـ price بتاع ${c.en} نفسه كام؟`,
    },
  },
  {
    answer: (c) => c.instructor,
    ask: {
      msa: (c, o) => `من مدرب كورس ${c.ar} تحديدًا، لا ${o.ar}؟`,
      egyptian: (c, o) => `اللي بيشرح ${c.ar} هو نفسه بتاع ${o.ar}؟ مين هو؟`,
      gulf: (c, o) => `منو مدرب ${c.ar}؟ مو مدرب ${o.ar}`,
      "code-switched": (c, o) => `مين الـ trainer بتاع ${c.en}، مش ${o.en}؟`,
    },
  },
  {
    answer: (c) => `${installment(c)} جنيه`,
    ask: {
      msa: (c, o) => `كم القسط الشهري لكورس ${c.ar}، وليس ${o.ar}؟`,
      egyptian: (c, o) => `قسط ${c.ar} الشهري كام؟ مش ${o.ar}`,
      gulf: (c, o) => `كم قسط دورة ${c.ar} بالشهر؟ مو ${o.ar}`,
      "code-switched": (c, o) => `الـ installment الشهري لـ${c.en} كام؟ مش ${o.en}`,
    },
  },
];

/** Questions the catalogue does not answer; a grounded bot says it does not know. */
const unanswerable: Template[] = [
  {
    msa: () => "هل لديكم كورس في هندسة الطيران؟",
    egyptian: () => "عندكم كورس هندسة طيران؟",
    gulf: () => "عندكم دورة هندسة طيران؟",
    "code-switched": () => "فيه course لـ aerospace engineering عندكم؟",
  },
  {
    msa: () => "هل توفر الأكاديمية سكنًا للمتدربين القادمين من خارج المدينة؟",
    egyptian: () => "الأكاديمية بتوفر سكن للي جاي من محافظة تانية؟",
    gulf: () => "توفرون سكن للمتدربين اللي من برا المدينة؟",
    "code-switched": () => "فيه accommodation للطلبة اللي من برا؟",
  },
  {
    msa: () => "هل يمكن دفع الرسوم بالعملات الرقمية؟",
    egyptian: () => "ينفع أدفع بالكريبتو؟",
    gulf: () => "أقدر أدفع بالعملات الرقمية؟",
    "code-switched": () => "بتقبلوا payment بالـ crypto؟",
  },
  {
    msa: (c) => `هل شهادة كورس ${c.ar} معتمدة من نقابة المهندسين؟`,
    egyptian: (c) => `شهادة كورس ${c.ar} معتمدة من النقابة؟`,
    gulf: (c) => `شهادة دورة ${c.ar} معتمدة من هيئة المهندسين؟`,
    "code-switched": (c) => `الـ certificate بتاعة ${c.en} accredited من النقابة؟`,
  },
  {
    msa: (c) => `كم عدد المتدربين في الدفعة الواحدة من كورس ${c.ar}؟`,
    egyptian: (c) => `الدفعة في كورس ${c.ar} فيها كام واحد؟`,
    gulf: (c) => `كم عدد الطلاب في دفعة دورة ${c.ar}؟`,
    "code-switched": (c) => `الـ class size في كورس ${c.en} كام؟`,
  },
  {
    msa: (c) => `هل يتضمن كورس ${c.ar} تدريبًا ميدانيًا في شركة؟`,
    egyptian: (c) => `كورس ${c.ar} فيه تدريب في شركة؟`,
    gulf: (c) => `دورة ${c.ar} فيها تدريب ميداني في شركة؟`,
    "code-switched": (c) => `فيه internship مع كورس ${c.en}؟`,
  },
];

function build(): Question[] {
  const out: Question[] = [];
  const add = (q: Omit<Question, "key">) =>
    out.push({ ...q, key: `${q.slice}-${String(out.length + 1).padStart(3, "0")}` });

  // Single-turn: 50 prose questions. Locale cycles fastest, so every fact meets every locale.
  for (let i = 0; i < 50; i++) {
    const locale = LOCALES[i % 4] as Locale;
    const fact = prose[Math.floor(i / 4) % prose.length] as Fact;
    const c = courses[(i * 7 + Math.floor(i / 20)) % courses.length] as Course;
    add({ slice: "single", locale, query: fact.ask[locale](c), course: c.code, answer: fact.answer(c) });
  }
  // Follow-ups: 50, each after an opener about a course.
  for (let i = 0; i < 50; i++) {
    const locale = LOCALES[i % 4] as Locale;
    const fact = followUps[Math.floor(i / 4) % followUps.length] as Fact;
    const c = courses[(i * 5 + 3) % courses.length] as Course;
    add({
      slice: "follow-up",
      locale,
      query: fact.ask[locale](c),
      history: {
        user: opener[locale](c),
        assistant: `كورس ${c.ar} يقدمه ${c.instructor} ومدته ${c.weeks} أسابيع.`,
      },
      course: c.code,
      answer: fact.answer(c),
    });
  }
  // Table lookups: 40.
  for (let i = 0; i < 40; i++) {
    const locale = LOCALES[i % 4] as Locale;
    const fact = tabled[Math.floor(i / 4) % tabled.length] as Fact;
    const c = courses[(i * 5 + 1) % courses.length] as Course;
    add({ slice: "table", locale, query: fact.ask[locale](c), course: c.code, answer: fact.answer(c) });
  }
  // Near-miss: 30, alternating between the two courses of each look-alike pair.
  for (let i = 0; i < 30; i++) {
    const locale = LOCALES[i % 4] as Locale;
    const pair = PAIRS[i % PAIRS.length] as readonly [string, string];
    const member = Math.floor(i / PAIRS.length) % 2;
    const c = by(pair[member] as string);
    const other = by(pair[1 - member] as string);
    const fact = nearMissFacts[Math.floor(i / 10) % nearMissFacts.length] as (typeof nearMissFacts)[number];
    add({ slice: "near-miss", locale, query: fact.ask[locale](c, other), course: c.code, answer: fact.answer(c) });
  }
  // Unanswerable: 30.
  for (let i = 0; i < 30; i++) {
    const locale = LOCALES[i % 4] as Locale;
    // The first 24 use every template once per locale; the last 6 reuse the course-specific ones
    // with other courses, so no question repeats.
    const template = (i < 24 ? unanswerable[Math.floor(i / 4)] : unanswerable[3 + ((i - 24) % 3)]) as Template;
    const c = courses[(i < 24 ? i * 7 + 2 : i + 7) % courses.length] as Course;
    add({ slice: "unanswerable", locale, query: template[locale](c) });
  }
  return out;
}

export const questions: readonly Question[] = build();
