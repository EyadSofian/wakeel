import { MessageTemplate } from "@wakeel/contracts";
import { SCREENSHOT_FIXTURES } from "@wakeel/testing/fixtures/rtl";
import { describe, expect, it } from "vitest";
import { checkValue } from "./fields";
import { convertMessage, MESSAGE_TYPES } from "./message/MessageEditor";

describe("convertMessage", () => {
  const start: MessageTemplate = { type: "text", text: "أهلاً {{user.name}}", format: "markdown" };

  it.each(MESSAGE_TYPES.map((t) => t.value))("text → %s is schema-valid", (type) => {
    const m = convertMessage(start, type);
    expect(m.type).toBe(type);
    expect(MessageTemplate.safeParse(m).success).toBe(true);
  });

  it("every type converts to every other type and stays valid", () => {
    for (const from of MESSAGE_TYPES) {
      const a = convertMessage(start, from.value);
      for (const to of MESSAGE_TYPES) {
        expect(MessageTemplate.safeParse(convertMessage(a, to.value)).success, `${from.value} → ${to.value}`).toBe(
          true,
        );
      }
    }
  });

  it("keeps the words: text → choice → card → text", () => {
    const choice = convertMessage(start, "choice");
    expect(choice.type === "choice" && choice.text).toBe("أهلاً {{user.name}}");
    const card = convertMessage(choice, "card");
    expect(card.type === "card" && card.title).toBe("أهلاً {{user.name}}");
    const back = convertMessage(card, "text");
    expect(back.type === "text" && back.text).toBe("أهلاً {{user.name}}");
  });

  it("choice → dropdown keeps the options", () => {
    const choice: MessageTemplate = { type: "choice", text: "Pick", options: [{ label: "شحن", value: "shipping" }] };
    const dropdown = convertMessage(choice, "dropdown");
    expect(dropdown.type === "dropdown" && dropdown.options).toEqual(choice.options);
  });
});

describe("checkValue", () => {
  it("required text must not be empty", () => {
    expect(checkValue("required", "  ", "Greeting")?.fix).toBe("Enter some text.");
    expect(checkValue("text", "", "Greeting")).toBeUndefined();
  });

  it("a broken placeholder gets the validator's message and fix", () => {
    const p = checkValue("text", "Hi {{user.name", "Greeting");
    expect(p?.message).toContain('"Greeting"');
    expect(p?.fix).toBe("Check that every {{ has a matching }} with an expression between them.");
  });

  it("an invalid expression names itself in the fix", () => {
    const p = checkValue("expression", "conversation.topic ==", "Greeting");
    expect(p?.fix).toBe("Correct the expression `conversation.topic ==`.");
    expect(checkValue("expression", "", "Greeting")?.fix).toBe("Enter an expression.");
    expect(checkValue("optional-expression", "", "Greeting")).toBeUndefined();
    expect(checkValue("expression", 'conversation.topic == "order"', "Greeting")).toBeUndefined();
  });

  it.each(SCREENSHOT_FIXTURES.map((f) => [f.id, f.text] as const))("RTL fixture %s is valid text", (_id, text) => {
    expect(checkValue("required", text, "عقدة")).toBeUndefined();
  });
});
