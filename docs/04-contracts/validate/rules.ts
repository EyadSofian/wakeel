import { fill } from "../errors";

/**
 * Every issue `validateDefinition` can report (task 2.2, architecture §3.1), with its severity, the
 * sentence that says what is wrong and the sentence that says how to fix it. Messages and fixes
 * come only from here; `{placeholders}` are filled by the rule. Errors block publishing; warnings
 * do not. Copy follows design system §3.3.
 */
export const ISSUE_RULES = {
  // The definition as a whole
  main_workflow_count: {
    severity: "error",
    message: "The bot has {count} main workflows.",
    fix: "Keep one main workflow and make the others sub-workflows.",
  },
  main_workflow_missing: {
    severity: "error",
    message: "The bot's main workflow is missing.",
    fix: "Mark one workflow as the main workflow.",
  },
  error_workflow_count: {
    severity: "error",
    message: "The bot has {count} error workflows.",
    fix: "Keep one error workflow.",
  },
  error_workflow_missing: {
    severity: "error",
    message: "The bot's error workflow setting points to a workflow that is missing or is not an error workflow.",
    fix: "Choose an error workflow in bot settings, or clear the setting.",
  },
  duplicate_id: {
    severity: "error",
    message: "Two elements share the id {id}.",
    fix: "Duplicate one of them again so it gets a new id, then delete the old copy.",
  },
  variable_name_duplicate: {
    severity: "error",
    message: 'Two {scope} variables are named "{name}".',
    fix: "Rename one of them.",
  },
  variable_scope: {
    severity: "error",
    message: 'Variable "{name}" is declared in the wrong place for its scope.',
    fix: "Declare workflow variables in their workflow and the others in bot settings.",
  },

  // Structure, from checkWorkflowStructure (its messages name the node; the fixes match these).
  start_node_count: {
    severity: "error",
    message: "The main workflow needs exactly one Start node.",
    fix: "Keep one Start node.",
  },
  start_outside_main: {
    severity: "error",
    message: "Only the main workflow can have a Start node.",
    fix: "Remove it or use an Entry node.",
  },
  entry_node_count: {
    severity: "error",
    message: "A sub-workflow needs exactly one Entry node.",
    fix: "Keep one Entry node.",
  },
  exit_node_missing: {
    severity: "error",
    message: "A sub-workflow needs at least one Exit node.",
    fix: "Add an Exit node.",
  },
  error_handler_count: {
    severity: "error",
    message: "A workflow can have one Error handler.",
    fix: "Remove the extra handler.",
  },
  edge_source_missing: {
    severity: "error",
    message: "A transition starts at a node that no longer exists.",
    fix: "Delete the transition.",
  },
  edge_target_missing: {
    severity: "error",
    message: "A transition points to a node that no longer exists.",
    fix: "Reconnect or delete it.",
  },
  edge_port_missing: {
    severity: "error",
    message: '"{node}" no longer has this output.',
    fix: "Delete the transition or restore the option.",
  },
  edge_target_invalid: {
    severity: "error",
    message: '"{node}" cannot be the target of a transition.',
    fix: "Connect to a different node.",
  },
  edge_duplicate: {
    severity: "error",
    message: '"{node}" has two transitions from the same output.',
    fix: "Keep one.",
  },
  exit_unconnected: {
    severity: "error",
    message: 'Exit "{exit}" on "{node}" leads nowhere.',
    fix: "Connect it to a node or remove the exit.",
  },
  tool_name_duplicate: { severity: "error", message: 'Two tools on "{node}" are named "{tool}".', fix: "Rename one." },
  autonomous_no_exit: {
    severity: "error",
    message: '"{node}" cannot talk to the user and has no exit.',
    fix: "Add an exit or allow conversation.",
  },

  // Routing and reachability
  routing_port_unconnected: {
    severity: "warning",
    message: '"{option}" on "{node}" is not connected, so it continues with the next card.',
    fix: "Connect it, or leave it if continuing is what you want.",
  },
  card_unreachable: {
    severity: "warning",
    message: 'Cards after "{card}" in "{node}" never run.',
    fix: "Move them before it, or delete them.",
  },

  // Variables and settings
  variable_unknown: {
    severity: "error",
    message: '"{ref}" in "{node}" is not a variable in this scope.',
    fix: "Create the variable or correct the name.",
  },
  variable_id_unknown: {
    severity: "error",
    message: '"{node}" uses a variable that no longer exists.',
    fix: "Choose a variable in the card.",
  },
  variable_type_mismatch: {
    severity: "error",
    message: '"{variable}" is a {actual} variable, but "{node}" stores {expected} in it.',
    fix: "Change the variable's type to {expected}, or choose another variable.",
  },
  variable_read_only: {
    severity: "error",
    message: '"{node}" changes the bot variable "{variable}", which is read-only while the bot runs.',
    fix: "Use a user or conversation variable instead.",
  },
  config_var_unknown: {
    severity: "error",
    message: '"env.{key}" in "{node}" is not a setting of this bot.',
    fix: "Add {key} under Secrets and settings, or correct the name.",
  },

  // Messages
  choice_text_empty: {
    severity: "error",
    message: 'A choice message in "{node}" has no question text.',
    fix: "Write the question the options answer.",
  },
  choice_option_empty: {
    severity: "error",
    message: 'An option in "{node}" has no label or value.',
    fix: "Give every option a label and a value.",
  },
  choice_value_duplicate: {
    severity: "error",
    message: 'Two options in "{node}" have the value "{value}".',
    fix: "Give every option a different value.",
  },

  // Autonomous nodes
  autonomous_instructions_empty: {
    severity: "error",
    message: '"{node}" has no instructions.',
    fix: "Describe what it should do, which tools to use and when to leave.",
  },

  // References to workflows, knowledge bases and tables
  workflow_unknown: {
    severity: "error",
    message: '"{node}" calls a workflow that no longer exists.',
    fix: "Choose a workflow in the card or tool.",
  },
  workflow_not_callable: {
    severity: "error",
    message: '"{node}" calls "{workflow}", which is not a sub-workflow.',
    fix: "Call a sub-workflow.",
  },
  call_input_missing: {
    severity: "error",
    message: '"{node}" does not set "{input}", which "{workflow}" needs.',
    fix: "Set it on the card that calls the workflow.",
  },
  call_input_unknown: {
    severity: "error",
    message: '"{node}" sets "{input}", which "{workflow}" does not declare.',
    fix: "Remove it, or add the input to the workflow.",
  },
  call_output_unknown: {
    severity: "error",
    message: '"{node}" reads "{output}", which "{workflow}" does not return.',
    fix: "Remove it, or add the output to the workflow.",
  },
  exit_output_unknown: {
    severity: "error",
    message: 'Exit node "{node}" sets "{output}", which the workflow does not declare.',
    fix: "Remove it, or add the output to the workflow.",
  },
  exit_output_missing: {
    severity: "error",
    message: 'Exit node "{node}" does not set "{output}".',
    fix: "Set every required output on each Exit node.",
  },
  kb_unknown: {
    severity: "error",
    message: '"{node}" searches a knowledge base that no longer exists.',
    fix: "Choose a knowledge base in the card or tool.",
  },
  table_unknown: {
    severity: "error",
    message: '"{node}" uses a table that no longer exists.',
    fix: "Choose a table in the card or tool.",
  },

  // Syntax
  template_syntax: {
    severity: "error",
    message: 'A message in "{node}" has a broken placeholder: {reason}.',
    fix: "Check that every {{ has a matching }} with an expression between them.",
  },
  expression_syntax: {
    severity: "error",
    message: 'An expression in "{node}" is not valid: {reason}.',
    fix: "Correct the expression `{expression}`.",
  },
  code_syntax: {
    severity: "error",
    message: 'The code in "{node}" has a syntax error on line {line}: {reason}.',
    fix: "Fix line {line}; the code editor marks it.",
  },
} as const satisfies Record<string, { severity: "error" | "warning"; message: string; fix: string }>;

export type IssueCode = keyof typeof ISSUE_RULES;

/** An issue with where it is, so the Studio can select the element (Issues panel, F8). */
export interface DefinitionIssue {
  severity: "error" | "warning";
  code: IssueCode;
  message: string;
  fix: string;
  /** `manifest.<field>` or `workflows.<wfId>.nodes.<nodeId>.cards.<cardId>.<field>`. */
  path: string;
  workflowId?: string;
  nodeId?: string;
  cardId?: string;
}

export interface IssueLocation {
  path: string;
  workflowId?: string;
  nodeId?: string;
  cardId?: string;
}

export function makeIssue(
  code: IssueCode,
  params: Record<string, string | number>,
  at: IssueLocation,
): DefinitionIssue {
  const rule = ISSUE_RULES[code];
  return { severity: rule.severity, code, message: fill(rule.message, params), fix: fill(rule.fix, params), ...at };
}
