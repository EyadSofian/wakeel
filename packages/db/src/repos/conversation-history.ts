import { AppError, ConversationHistoryItem, type ConversationHistoryQuery, Message } from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "../client";

const fields = sql`c.id, c.status, c.connection_id as "connectionId", b.name as "connectionName",
  to_char(c.last_activity_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "lastActivityAt",
  exists(select 1 from turns t where t.conversation_id = c.id and t.status = 'failed') as "hasError",
  jsonb_build_object('id', u.id, 'externalId', u.external_id, 'name', u.attributes ->> 'name') as "user"`;
const joined = sql`conversations c
  join bridge_connections b on b.id = c.connection_id and b.workspace_id = c.workspace_id
  join end_users u on u.id = c.end_user_id and u.workspace_id = c.workspace_id`;

export async function listConversationHistory(
  tx: Tx,
  botId: string,
  { connectionId, status, from, until, hasError, handedOff, search, limit }: ConversationHistoryQuery,
  before?: { lastActivityAt: string; id: string },
) {
  const conditions = [sql`c.bot_id = ${botId} and c.mode = 'live'`];
  if (connectionId) conditions.push(sql`c.connection_id = ${connectionId}`);
  if (status) conditions.push(sql`c.status = ${status}`);
  if (from) conditions.push(sql`c.last_activity_at >= ${from}::timestamptz`);
  if (until) conditions.push(sql`c.last_activity_at < ${until}::timestamptz`);
  if (hasError !== undefined)
    conditions.push(
      sql`exists(select 1 from turns t where t.conversation_id=c.id and t.status='failed') = ${hasError}`,
    );
  if (handedOff !== undefined) conditions.push(sql`(c.status = 'handed_off') = ${handedOff}`);
  if (before) conditions.push(sql`(c.last_activity_at, c.id) < (${before.lastActivityAt}::timestamptz, ${before.id})`);
  if (search) {
    conditions.push(sql`(
      strpos(lower(u.external_id), lower(${search})) > 0
      or strpos(lower(u.attributes ->> 'name'), lower(${search})) > 0
      or exists(select 1 from messages m where m.conversation_id = c.id
        and strpos(lower(m.payload ->> 'text'), lower(${search})) > 0)
    )`);
  }
  const result = await tx.execute(sql`select ${fields} from ${joined}
    where ${sql.join(conditions, sql` and `)}
    order by c.last_activity_at desc, c.id desc limit ${limit + 1}`);
  return result.rows.map((row) => ConversationHistoryItem.parse(row));
}

export async function conversationTranscript(tx: Tx, botId: string, id: string, limit: number, before?: number) {
  const result = await tx.execute(sql`select ${fields} from ${joined}
    where c.bot_id = ${botId} and c.id = ${id} and c.mode = 'live'`);
  const conversation = result.rows[0];
  if (!conversation) throw new AppError("not_found");

  const messages =
    await tx.execute(sql`select id, conversation_id as "conversationId", seq, direction, payload, citations,
    turn_id as "turnId", external_id as "externalId", to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
    from messages where conversation_id = ${id} ${before === undefined ? sql`` : sql`and seq < ${before}`}
    order by seq desc limit ${limit + 1}`);
  const data = messages.rows.slice(0, limit).map((m) =>
    Message.parse({
      ...m,
      seq: Number(m["seq"]),
      turnId: m["turnId"] ?? undefined,
      externalId: m["externalId"] ?? undefined,
    }),
  );
  return {
    conversation: ConversationHistoryItem.parse(conversation),
    messages: data.toReversed(),
    nextCursor: messages.rows.length > limit ? String(data.at(-1)?.seq) : null,
  };
}
