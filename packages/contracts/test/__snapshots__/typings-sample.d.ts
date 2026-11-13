// Guest API for code in workflow "Track order" of bot "متجر النور".
// Generated from the bot's variables, config variables and tables. Do not edit.

declare namespace Guest {
  /** Any value that survives JSON: what variables, tables and tool results hold. */
  type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

  /** A message the bot can send. A plain string is a text message. */
  type BotMessage =
    | {
      type: "text";
      text: string;
      format?: "markdown" | "plain";
    }
    | {
      type: "image";
      url: string;
      alt?: string;
      caption?: string;
    }
    | {
      type: "file";
      url: string;
      name: string;
      mime?: string;
      sizeBytes?: number;
    }
    | {
      type: "location";
      latitude: number;
      longitude: number;
      title?: string;
      address?: string;
    }
    | {
      type: "choice";
      text: string;
      options: Array<{
        label: string;
        value: string;
      }>;
    }
    | {
      type: "dropdown";
      text: string;
      placeholder?: string;
      options: Array<{
        label: string;
        value: string;
      }>;
    }
    | {
      title: string;
      subtitle?: string;
      imageUrl?: string;
      actions?: Array<{
        type: "postback" | "url" | "say";
        label: string;
        value: string;
      }>;
      type: "card";
    }
    | {
      type: "carousel";
      items: Array<{
        title: string;
        subtitle?: string;
        imageUrl?: string;
        actions?: Array<{
          type: "postback" | "url" | "say";
          label: string;
          value: string;
        }>;
      }>;
    }
    | {
      type: "custom";
      name: string;
      data: Guest.Json;
    };

  /** The inbound event this turn is handling. */
  type Event = {
    readonly kind: "message" | "event" | "user_update" | "tool_result" | "handoff_release" | "timeout";
    readonly text: string;
    readonly message?:
      | {
        readonly type: "text";
        readonly text: string;
        readonly format: "markdown" | "plain";
      }
      | {
        readonly type: "image";
        readonly url: string;
        readonly alt?: string;
        readonly caption?: string;
      }
      | {
        readonly type: "file";
        readonly url: string;
        readonly name: string;
        readonly mime?: string;
        readonly sizeBytes?: number;
      }
      | {
        readonly type: "location";
        readonly latitude: number;
        readonly longitude: number;
        readonly title?: string;
        readonly address?: string;
      }
      | {
        readonly type: "postback";
        readonly value: string;
        readonly label?: string;
      }
      | {
        readonly type: "custom";
        readonly name: string;
        readonly data: Guest.Json;
      };
    readonly name?: string;
    readonly payload: { readonly [key: string]: Guest.Json };
    readonly metadata: { readonly [key: string]: Guest.Json };
    readonly exit?: {
      readonly name: string;
      readonly data: Guest.Json;
    };
    readonly conversationId: string;
    readonly externalConversationId: string;
    readonly userId: string;
    readonly externalUserId: string;
    readonly receivedAt: string;
  };

  /** A passage found by `kb.search`. Put `cite` in a reply to cite it. */
  type Passage = {
    readonly chunkId: string;
    readonly documentId: string;
    readonly title: string;
    readonly uri?: string;
    readonly headingPath: string[];
    readonly text: string;
    readonly score: number;
    readonly cite: string;
    readonly meta: { readonly [key: string]: Guest.Json };
  };

  /** Operators a column condition can use. */
  interface Operators<V> {
    eq: V;
    ne: V;
    gt: V;
    gte: V;
    lt: V;
    lte: V;
    in: V[];
    contains: string;
    startsWith: string;
    isNull: boolean;
  }

  /** One condition on a column: exactly one operator, such as `{ eq: "shipped" }`. */
  type Condition<V> = {
    [K in keyof Operators<V>]: { [P in K]: Operators<V>[P] } & { [P in Exclude<keyof Operators<V>, K>]?: never };
  }[keyof Operators<V>];

  /** Which rows: column conditions, combined with `and`, `or` and `not`. */
  type Filter<Row> =
    | { and: Filter<Row>[] }
    | { or: Filter<Row>[] }
    | { not: Filter<Row> }
    | { [K in keyof Row]?: Condition<Row[K]> };

  interface FindOptions<Row> {
    where?: Filter<Row>;
    /** Full-text search over the table's searchable columns. */
    search?: string;
    sort?: { column: keyof Row & string; direction?: "asc" | "desc" }[];
    /** 1 to 500; 10 when left out. */
    limit?: number;
  }

  /** A table's rows. Every row also has an `id`. */
  interface Table<Row> {
    find(options?: FindOptions<Row>): Promise<(Row & { readonly id: string })[]>;
    /** The first row that matches, or null. */
    get(where: Filter<Row>): Promise<(Row & { readonly id: string }) | null>;
    insert(values: Row): Promise<Row & { readonly id: string }>;
    /** Changes every row that matches; resolves to how many changed. */
    update(where: Filter<Row>, values: Partial<Row>): Promise<number>;
    /** Inserts, or updates the row whose `on` column has the same value. */
    upsert(values: Row, on: keyof Row & string): Promise<Row & { readonly id: string }>;
    /** Deletes every row that matches; resolves to how many were deleted. */
    delete(where: Filter<Row>): Promise<number>;
  }

  interface RequestInit {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
    headers?: { [name: string]: string };
    body?: string;
  }

  interface Response {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    readonly headers: { get(name: string): string | null };
    text(): Promise<string>;
    // The body is whatever the remote service sent; narrow it before use.
    json(): Promise<any>;
  }

  interface AxiosResponse {
    readonly status: number;
    readonly statusText: string;
    readonly headers: { readonly [name: string]: string };
    // Parsed JSON when the response is JSON, otherwise the text.
    readonly data: any;
  }

  interface AxiosConfig {
    headers?: { [name: string]: string };
    params?: { [name: string]: string | number | boolean };
  }
}

/** Sends a message to the user now. A string is sent as a text message. */
declare function say(message: string | Guest.BotMessage): Promise<void>;

/** Calls a URL through the egress proxy: 10 s timeout, 5 MB response, 5 redirects. */
declare function fetch(url: string, init?: Guest.RequestInit): Promise<Guest.Response>;

/** A small axios-shaped helper over `fetch`, for code moved from other platforms. */
declare const axios: {
  get(url: string, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
  delete(url: string, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
  post(url: string, data?: Guest.Json, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
  put(url: string, data?: Guest.Json, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
  patch(url: string, data?: Guest.Json, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
};

/** Knowledge bases of this workspace. */
declare const kb: {
  search(query: string, options?: { kbIds?: string[]; topK?: number }): Promise<Guest.Passage[]>;
};

/** Models, through the bot's model settings. */
declare const ai: {
  /** Generates text. Uses the bot's default model unless `model` is given. */
  generate(options: { instructions: string; input?: string; model?: string; maxOutputTokens?: number }): Promise<string>;
  /** Extracts data that matches `schema` from `input`. Uses the utility model unless `model` is given. */
  extract(options: {
    input: string;
    schema: { [keyword: string]: Guest.Json };
    instructions?: string;
    model?: string;
  }): Promise<Guest.Json>;
  /** Picks one of `labels` for `input`. Uses the utility model unless `model` is given. */
  classify(options: { input: string; labels: string[]; instructions?: string; model?: string }): Promise<string>;
};

/** Writes to the conversation log and the trace. Never shown to the user. */
declare const log: {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const ctx: {
  /** The same on every retry of this step: pass it to services that deduplicate requests. */
  readonly idempotencyKey: string;
};

/** The inbound event this turn is handling. */
declare const event: Guest.Event;

/** Scratch values for this turn only; cleared when the turn ends. */
declare const turn: { [key: string]: Guest.Json };

/** This workflow's variables, inputs and outputs. Cleared when the workflow returns. */
declare const workflow: {
  /**
   * Input of this workflow.
   * As the user typed it.
   */
  orderNumber: string;
  /** Input of this workflow. */
  notify: boolean | undefined;
  /** Output of this workflow. */
  status: string | undefined;
  email: string | undefined;
  /** @default 0 */
  attempts: number;
  tags: string[] | undefined;
  raw: Guest.Json;
};

/** Conversation variables: kept until the conversation ends. */
declare const conversation: {
  language: "ar" | "en" | undefined;
  cart: {
    items: Array<{
      sku: string;
      qty: number;
    }>;
    /** Code typed by the user, e.g. RAMADAN *\/ 10 */
    coupon?: string;
  } | undefined;
  /** An ISO 8601 date and time. */
  lastOrderAt: string | undefined;
};

/** User variables: kept for this end user across conversations. */
declare const user: {
  /**
   * Subscription plan.
   * @default "free"
   */
  plan: "free" | "pro";
  /** Sensitive: redacted in traces and the emulator. */
  phone: string | undefined;
  /** Data your bridge sent about the user. Read-only. */
  readonly attributes: { readonly [key: string]: Guest.Json };
};

/** Bot variables: set in the Studio, read-only while the bot runs. */
declare const bot: {
  /** @default "النور" */
  readonly storeName: string;
  /** @default {"from":9,"to":21} */
  readonly openHours: { [key: string]: Guest.Json };
};

/** Configuration variables. Values come from the environment the bot runs in; read-only. */
declare const env: {
  /**
   * Key for the shop's order API.
   * Secret: its value is redacted from logs and traces.
   */
  readonly SHOP_API_KEY: string;
  readonly SHOP_URL: string;
};

/** Tables of this workspace. */
declare const tables: {
  /** Orders placed in the shop. */
  readonly orders: Guest.Table<{
    /** Unique in the table. */
    number: string;
    status: "placed" | "shipped" | "delivered";
    total: number | null;
    /** An ISO 8601 date and time. */
    placedAt: string;
    meta: Guest.Json | null;
  }>;
};
