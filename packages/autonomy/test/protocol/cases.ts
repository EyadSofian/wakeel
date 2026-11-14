import { LANGUAGE_FIXTURES, SCREENSHOT_FIXTURES } from "@wakeel/testing";
import type { FinishReason, ProtocolContext, ProtocolIssueCode, ResolvedExit } from "../../src/protocol/index";
import { ALL_TYPES, exitId, lines } from "./helpers";

/**
 * Turn protocol v1 cases (architecture §6.2, build plan 6.3). Each one is run whole, one code unit
 * at a time, at every two-chunk split and at seeded random splits; every chunking must give the
 * same events and the same result.
 */
export interface ParserCase {
  name: string;
  input: string;
  ctx?: Partial<ProtocolContext>;
  finish?: FinishReason;
  /** Message payloads sent, in order. Defaults to none. */
  says?: unknown[];
  run?: string;
  exit?: ResolvedExit;
  issue?: ProtocolIssueCode;
  issueLine?: number;
  recovered?: boolean;
}

const ar = (id: string): string => {
  const f = [...SCREENSHOT_FIXTURES, ...LANGUAGE_FIXTURES].find((x) => x.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return f.text;
};

const text = (t: string, format: "markdown" | "plain" = "markdown") => ({ type: "text", text: t, format });
const LISTEN: ResolvedExit = { kind: "listen" };
const HANDOFF: Partial<ProtocolContext> = { allowHandoff: true };
const ALL: Partial<ProtocolContext> = { messageTypes: ALL_TYPES };

export const CASES: ParserCase[] = [
  /* ------------------------------------------------------------ valid shapes */
  {
    name: "spec example: two says then exit listen and end",
    input: lines(
      ":::say text",
      "Your order shipped yesterday and should arrive Thursday.",
      ':::say choice {"options":[{"label":"Track it","value":"track"},{"label":"That\'s all","value":"done"}]}',
      "Anything else?",
      ":::exit listen",
      ":::end",
    ),
    says: [
      text("Your order shipped yesterday and should arrive Thursday."),
      {
        type: "choice",
        text: "Anything else?",
        options: [
          { label: "Track it", value: "track" },
          { label: "That's all", value: "done" },
        ],
      },
    ],
    exit: LISTEN,
  },
  {
    name: "spec example: say then run and end",
    input: lines(
      ":::say text",
      "Let me check that order.",
      ":::run",
      'const order = await tables.orders.find({ where: { number: { eq: "5678" } }, limit: 1 })',
      "return order",
      ":::end",
    ),
    says: [text("Let me check that order.")],
    run: 'const order = await tables.orders.find({ where: { number: { eq: "5678" } }, limit: 1 })\nreturn order',
  },
  {
    name: "missing :::end after exit (the stop sequence was stripped)",
    input: lines(":::say text", "Hi", ":::exit listen"),
    says: [text("Hi")],
    exit: LISTEN,
  },
  {
    name: "missing :::end after a run block",
    input: lines(":::run", "return 1"),
    run: "return 1",
  },
  {
    name: "missing :::end with a trailing newline",
    input: ":::say text\nHi\n:::exit listen\n",
    says: [text("Hi")],
    exit: LISTEN,
  },
  { name: "exit only", input: lines(":::exit listen", ":::end"), exit: LISTEN },
  {
    name: "three says in order",
    input: lines(":::say text", "One", ":::say text", "Two", ":::say text", "Three", ":::exit listen"),
    says: [text("One"), text("Two"), text("Three")],
    exit: LISTEN,
  },
  {
    name: "text props set the format",
    input: lines(':::say text {"format":"plain"}', "*not bold*", ":::exit listen"),
    says: [text("*not bold*", "plain")],
    exit: LISTEN,
  },
  {
    name: "multi-line body keeps inner blank lines and drops outer ones",
    input: lines(":::say text", "", "Line one", "", "  - indented item", "Line three", "", "", ":::exit listen"),
    says: [text("Line one\n\n  - indented item\nLine three")],
    exit: LISTEN,
  },
  {
    name: "CRLF line endings",
    input: ":::say text\r\nHello\r\nWorld\r\n:::exit listen\r\n:::end\r\n",
    says: [text("Hello\nWorld")],
    exit: LISTEN,
  },
  {
    name: "trailing spaces after directive keywords",
    input: lines(":::say text   ", "Hi", ":::run  ", "return 2", ":::end   "),
    says: [text("Hi")],
    run: "return 2",
  },
  {
    name: "a tab separates the keyword from its arguments",
    input: lines(":::say\ttext", "Hi", ":::exit\tlisten"),
    says: [text("Hi")],
    exit: LISTEN,
  },
  {
    name: "blank lines before the first directive are fine",
    input: lines("", "   ", ":::say text", "Hi", ":::exit listen"),
    says: [text("Hi")],
    exit: LISTEN,
  },
  {
    name: "anything after :::end is ignored",
    input: lines(":::say text", "Hi", ":::exit listen", ":::end", ":::say text", "Ignored", "garbage"),
    says: [text("Hi")],
    exit: LISTEN,
  },
  {
    name: "run then exit are both kept for the precedence rule",
    input: lines(":::run", "workflow.status = 'checked'", ":::exit done", ":::end"),
    run: "workflow.status = 'checked'",
    exit: { kind: "exit", exitId: exitId("done"), name: "done", data: {} },
  },
  {
    name: "say, run and exit together",
    input: lines(":::say text", "Saving.", ":::run", "workflow.saved = true", ":::exit done"),
    says: [text("Saving.")],
    run: "workflow.saved = true",
    exit: { kind: "exit", exitId: exitId("done"), name: "done", data: {} },
  },

  /* ------------------------------------------------------------ message types */
  {
    name: "dropdown with a placeholder",
    ctx: ALL,
    input: lines(
      ':::say dropdown {"placeholder":"Pick a city","options":[{"label":"Cairo","value":"cai"}]}',
      "Where to?",
      ":::exit listen",
    ),
    says: [
      { type: "dropdown", text: "Where to?", placeholder: "Pick a city", options: [{ label: "Cairo", value: "cai" }] },
    ],
    exit: LISTEN,
  },
  {
    name: "image body becomes the caption",
    ctx: ALL,
    input: lines(
      ':::say image {"url":"https://cdn.example.com/a.png","alt":"Receipt"}',
      "Your receipt",
      ":::exit listen",
    ),
    says: [{ type: "image", url: "https://cdn.example.com/a.png", alt: "Receipt", caption: "Your receipt" }],
    exit: LISTEN,
  },
  {
    name: "image without a body has no caption",
    ctx: ALL,
    input: lines(':::say image {"url":"https://cdn.example.com/a.png"}', ":::exit listen"),
    says: [{ type: "image", url: "https://cdn.example.com/a.png" }],
    exit: LISTEN,
  },
  {
    name: "card takes everything from props",
    ctx: ALL,
    input: lines(
      ':::say card {"title":"Order 5678","actions":[{"type":"postback","label":"Track","value":"track"}]}',
      ":::exit listen",
    ),
    says: [{ type: "card", title: "Order 5678", actions: [{ type: "postback", label: "Track", value: "track" }] }],
    exit: LISTEN,
  },
  {
    name: "carousel",
    ctx: ALL,
    input: lines(':::say carousel {"items":[{"title":"A"},{"title":"B"}]}', ":::exit listen"),
    says: [
      {
        type: "carousel",
        items: [
          { title: "A", actions: [] },
          { title: "B", actions: [] },
        ],
      },
    ],
    exit: LISTEN,
  },
  {
    name: "location",
    ctx: ALL,
    input: lines(':::say location {"latitude":30.04,"longitude":31.23,"title":"Branch"}', ":::exit listen"),
    says: [{ type: "location", latitude: 30.04, longitude: 31.23, title: "Branch" }],
    exit: LISTEN,
  },
  {
    name: "file",
    ctx: ALL,
    input: lines(':::say file {"url":"https://cdn.example.com/i.pdf","name":"invoice.pdf"}', ":::exit listen"),
    says: [{ type: "file", url: "https://cdn.example.com/i.pdf", name: "invoice.pdf" }],
    exit: LISTEN,
  },

  /* ------------------------------------------------------------ bodies with :::-like text */
  {
    name: "body with ::: in the middle of a line",
    input: lines(":::say text", "Use ::: to separate sections.", ":::exit listen"),
    says: [text("Use ::: to separate sections.")],
    exit: LISTEN,
  },
  {
    name: "body line ending in :::",
    input: lines(":::say text", "Ratio 1:::2 and then :::", ":::exit listen"),
    says: [text("Ratio 1:::2 and then :::")],
    exit: LISTEN,
  },
  {
    name: "body with x:::end not at column 0",
    input: lines(":::say text", "x:::end", "y :::exit listen", ":::exit listen"),
    says: [text("x:::end\ny :::exit listen")],
    exit: LISTEN,
  },
  {
    name: "body with two colons is text",
    input: lines(":::say text", "::say text", ":: :end", ":::exit listen"),
    says: [text("::say text\n:: :end")],
    exit: LISTEN,
  },
  {
    name: "body with full-width colons is text",
    input: lines(":::say text", "：：：say text", ":::exit listen"),
    says: [text("：：：say text")],
    exit: LISTEN,
  },
  {
    name: "body with a word that starts like a directive is still a column-0 marker",
    input: lines(":::say text", "Hi", ":::sayonara", ":::exit listen"),
    says: [],
    issue: "unknown_directive",
    issueLine: 3,
  },
  {
    name: "body line that is only the marker",
    input: lines(":::say text", "Hi", ":::", ":::exit listen"),
    issue: "unknown_directive",
    issueLine: 3,
  },
  {
    name: "indented directive inside a body",
    input: lines(":::say text", "Hi", "  :::exit listen"),
    issue: "directive_not_at_line_start",
    issueLine: 3,
  },
  {
    name: "directive behind a right-to-left mark",
    input: lines(":::say text", "مرحبا", "‏:::exit listen"),
    issue: "directive_not_at_line_start",
    issueLine: 3,
  },
  {
    name: "props JSON containing :::end",
    input: lines(':::say choice {"options":[{"label":"Say :::end","value":":::end"}]}', "Pick", ":::exit listen"),
    says: [{ type: "choice", text: "Pick", options: [{ label: "Say :::end", value: ":::end" }] }],
    exit: LISTEN,
  },
  {
    name: "exit data containing :::",
    input: lines(':::exit order_found {"orderId":"A:::B","note":":::run"}'),
    exit: {
      kind: "exit",
      exitId: exitId("orderFound"),
      name: "order_found",
      data: { orderId: "A:::B", note: ":::run" },
    },
  },
  {
    name: "run body with ::: inside strings and ternaries",
    input: lines(":::run", "const s = `a ::: b`", "const t = ok ? 1 : 2", "return { s, t }", ":::end"),
    run: "const s = `a ::: b`\nconst t = ok ? 1 : 2\nreturn { s, t }",
  },

  /* ------------------------------------------------------------ Arabic */
  {
    name: "pure Arabic body",
    input: lines(":::say text", ar("pure_arabic"), ":::exit listen"),
    says: [text(ar("pure_arabic"))],
    exit: LISTEN,
  },
  {
    name: "Egyptian dialect, two lines",
    input: lines(":::say text", ar("egyptian"), ar("arabic_product_code"), ":::exit listen"),
    says: [text(`${ar("egyptian")}\n${ar("arabic_product_code")}`)],
    exit: LISTEN,
  },
  {
    name: "Arabic–English code-switching body",
    input: lines(":::say text", ar("code_switch"), ":::exit listen"),
    says: [text(ar("code_switch"))],
    exit: LISTEN,
  },
  {
    name: "Arabic with diacritics and emoji",
    input: lines(":::say text", ar("arabic_diacritics"), ar("emoji"), ":::exit listen"),
    says: [text(`${ar("arabic_diacritics")}\n${ar("emoji")}`)],
    exit: LISTEN,
  },
  {
    name: "Arabic-Indic digits and a URL",
    input: lines(":::say text", ar("arabic_indic_digits"), ar("arabic_url"), ":::exit listen"),
    says: [text(`${ar("arabic_indic_digits")}\n${ar("arabic_url")}`)],
    exit: LISTEN,
  },
  {
    name: "Arabic choice labels",
    input: lines(
      ':::say choice {"options":[{"label":"تتبع الطلب","value":"track"},{"label":"خلاص كده","value":"done"}]}',
      "تحب أعمل إيه؟",
      ":::exit listen",
    ),
    says: [
      {
        type: "choice",
        text: "تحب أعمل إيه؟",
        options: [
          { label: "تتبع الطلب", value: "track" },
          { label: "خلاص كده", value: "done" },
        ],
      },
    ],
    exit: LISTEN,
  },
  {
    name: "Arabic exit data",
    input: lines(':::exit order_found {"orderId":"٤٥١٢٣","note":"العميل مستعجل"}'),
    exit: {
      kind: "exit",
      exitId: exitId("orderFound"),
      name: "order_found",
      data: { orderId: "٤٥١٢٣", note: "العميل مستعجل" },
    },
  },
  {
    name: "Arabic body with an RTL mark inside a line is text",
    input: lines(":::say text", "‏رقم الطلب: ORD-1", ":::exit listen"),
    says: [text("‏رقم الطلب: ORD-1")],
    exit: LISTEN,
  },
  {
    name: "plain Arabic reply is recovered when conversational",
    input: ar("gulf"),
    says: [text(ar("gulf"))],
    exit: LISTEN,
    recovered: true,
  },
  {
    name: "run body with Arabic strings",
    input: lines(":::run", `workflow.reply = "${ar("egyptian")}"`, ":::exit done"),
    run: `workflow.reply = "${ar("egyptian")}"`,
    exit: { kind: "exit", exitId: exitId("done"), name: "done", data: {} },
  },

  /* ------------------------------------------------------------ recovery and incomplete replies */
  {
    name: "plain text is recovered as say text + exit listen",
    input: lines("Your order shipped.", "It arrives Thursday."),
    says: [text("Your order shipped.\nIt arrives Thursday.")],
    exit: LISTEN,
    recovered: true,
  },
  {
    name: "plain text then :::end is still recovered",
    input: lines("Your order shipped.", ":::end"),
    says: [text("Your order shipped.")],
    exit: LISTEN,
    recovered: true,
  },
  {
    name: "plain text is a protocol error when not conversational",
    ctx: { conversational: false },
    input: "Your order shipped.",
    issue: "no_directives",
  },
  { name: "empty reply", input: "", issue: "empty_response" },
  { name: "whitespace-only reply", input: "  \n\n\t\n", issue: "empty_response" },
  { name: "only :::end", input: ":::end", issue: "empty_response" },
  {
    name: "plain text with an indented directive is not recovered",
    input: lines("Sure thing.", "  :::exit listen"),
    issue: "directive_not_at_line_start",
    issueLine: 2,
  },
  {
    name: "plain text cut off by the length limit is not recovered",
    input: "Your order shipped and",
    finish: "length",
    issue: "incomplete",
  },
  {
    name: "cut off inside a say keeps the says already finished",
    input: lines(":::say text", "First.", ":::say text", "Second and"),
    finish: "length",
    says: [text("First.")],
    issue: "incomplete",
  },
  {
    name: "length finish after an explicit :::end is complete",
    input: lines(":::say text", "Hi", ":::exit listen", ":::end"),
    finish: "length",
    says: [text("Hi")],
    exit: LISTEN,
  },
  {
    name: "stream error before :::end",
    input: lines(":::run", "return 1"),
    finish: "error",
    issue: "incomplete",
  },
  {
    name: "says without a run or an exit",
    input: lines(":::say text", "Hi", ":::end"),
    says: [text("Hi")],
    issue: "no_action",
  },

  /* ------------------------------------------------------------ order rules */
  {
    name: "two run blocks",
    input: lines(":::say text", "Checking.", ":::run", "return 1", ":::run", "return 2", ":::end"),
    says: [text("Checking.")],
    issue: "run_twice",
    issueLine: 5,
  },
  {
    name: "say after run",
    input: lines(":::run", "return 1", ":::say text", "Late", ":::end"),
    issue: "say_after_run",
    issueLine: 3,
  },
  {
    name: "say after exit",
    input: lines(":::exit listen", ":::say text", "Late"),
    issue: "say_after_exit",
    issueLine: 2,
  },
  {
    name: "run after exit",
    input: lines(":::exit done", ":::run", "return 1"),
    issue: "run_after_exit",
    issueLine: 2,
  },
  {
    name: "two exits",
    input: lines(":::exit done", ":::exit listen"),
    issue: "exit_twice",
    issueLine: 2,
  },
  {
    name: "text before the first directive",
    input: lines("Sure!", ":::say text", "Hi", ":::exit listen"),
    issue: "text_before_directive",
    issueLine: 1,
  },
  {
    name: "parsing stops at the first error",
    input: lines(":::say text", "One", ":::say text", "Two", ":::ask", ":::say text", "Three", ":::exit listen"),
    // "Two" was still open when the bad line arrived, so it is not sent.
    says: [text("One")],
    issue: "unknown_directive",
    issueLine: 5,
  },
  { name: "four colons", input: lines("::::say text", "Hi"), issue: "unknown_directive", issueLine: 1 },
  { name: "upper-case keyword", input: lines(":::SAY text", "Hi"), issue: "unknown_directive", issueLine: 1 },

  /* ------------------------------------------------------------ say errors */
  { name: "say without a type", input: lines(":::say", "Hi", ":::exit listen"), issue: "say_type_missing" },
  { name: "unknown message type", input: lines(":::say video", "Hi", ":::exit listen"), issue: "say_type_unknown" },
  {
    name: "message type the node does not allow",
    input: lines(':::say card {"title":"A"}', ":::exit listen"),
    issue: "say_type_not_allowed",
  },
  {
    name: "custom messages are never allowed",
    ctx: ALL,
    input: lines(':::say custom {"name":"x","data":1}', ":::exit listen"),
    issue: "say_type_not_allowed",
  },
  { name: "props that are not JSON", input: lines(":::say text {format: plain}", "Hi"), issue: "say_props_invalid" },
  { name: "props that are a JSON array", input: lines(':::say text ["plain"]', "Hi"), issue: "say_props_invalid" },
  {
    name: "props that repeat the type",
    input: lines(':::say text {"type":"choice"}', "Hi", ":::exit listen"),
    issue: "say_props_invalid",
  },
  {
    name: "props that carry the body text",
    input: lines(':::say text {"text":"Hi"}', ":::exit listen"),
    issue: "say_props_invalid",
  },
  { name: "text with an empty body", input: lines(":::say text", "   ", ":::exit listen"), issue: "say_body_missing" },
  {
    name: "choice with an empty body",
    input: lines(':::say choice {"options":[{"label":"A","value":"a"}]}', ":::exit listen"),
    issue: "say_body_missing",
  },
  {
    name: "card with a body",
    ctx: ALL,
    input: lines(':::say card {"title":"A"}', "Some text", ":::exit listen"),
    issue: "say_body_not_allowed",
  },
  { name: "choice without options", input: lines(":::say choice", "Pick", ":::exit listen"), issue: "say_invalid" },
  {
    name: "unknown prop key",
    input: lines(':::say text {"colour":"red"}', "Hi", ":::exit listen"),
    issue: "say_invalid",
  },
  {
    name: "text longer than the message limit",
    input: lines(":::say text", "ا".repeat(8_001), ":::exit listen"),
    issue: "say_invalid",
  },

  /* ------------------------------------------------------------ run errors */
  { name: "run with arguments", input: lines(":::run js", "return 1"), issue: "run_arguments", issueLine: 1 },
  { name: "empty run block", input: lines(":::run", "", "  ", ":::end"), issue: "run_empty" },

  /* ------------------------------------------------------------ exit errors */
  { name: "exit without a name", input: ":::exit", issue: "exit_name_missing" },
  { name: "unknown exit", input: ":::exit finished", issue: "exit_unknown" },
  {
    name: "listen when the node is not conversational",
    ctx: { conversational: false },
    input: ":::exit listen",
    issue: "exit_unknown",
  },
  { name: "handoff when the node does not allow it", input: ":::exit handoff", issue: "exit_unknown" },
  {
    name: "handoff with a reason and summary",
    ctx: HANDOFF,
    input: ':::exit handoff {"reason":"Refund over limit","summary":"طلب استرجاع ٢٥٠ جنيه"}',
    exit: { kind: "handoff", reason: "Refund over limit", summary: "طلب استرجاع ٢٥٠ جنيه" },
  },
  { name: "handoff without data", ctx: HANDOFF, input: ":::exit handoff", exit: { kind: "handoff" } },
  {
    name: "handoff with an unknown field",
    ctx: HANDOFF,
    input: ':::exit handoff {"priority":"high"}',
    issue: "exit_data_invalid",
  },
  { name: "exit data that is not JSON", input: ":::exit order_found {orderId: 1}", issue: "exit_data_invalid" },
  {
    name: "exit data that does not match the schema",
    input: ':::exit order_found {"orderId":42}',
    issue: "exit_data_mismatch",
  },
  { name: "exit with a schema and no data", input: ":::exit order_found", issue: "exit_data_mismatch" },
  { name: "exit without a schema given data", input: ':::exit done {"a":1}', issue: "exit_data_invalid" },
  { name: "listen given data", input: ':::exit listen {"a":1}', issue: "exit_data_invalid" },
  {
    name: "JSON on the line after the exit",
    input: lines(":::exit order_found", '{"orderId":"1"}', ":::end"),
    issue: "exit_body",
    issueLine: 2,
  },
];
