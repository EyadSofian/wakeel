import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CreateFileResponse,
  type KbSettings,
  type KbSourceConfig,
  KnowledgeChunk,
  KnowledgeDocumentDetail,
  KnowledgeDocumentSummary,
  KnowledgeSourceSummary,
  type KnowledgeSummary,
  TestKnowledgeResult,
} from "@wakeel/contracts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  Td,
  Textarea,
  THead,
  Th,
  Tr,
  tabClasses,
} from "@wakeel/ui";
import { type FormEvent, useState } from "react";
import { ApiError, api, networkProblem } from "../../api/client";
import { knowledgePath, useKnowledgeBase, useKnowledgeBases, useKnowledgePage } from "../../api/knowledge";
import { useModels } from "../../api/models";
import { AppShell } from "../../shell/AppShell";
import { Page, PageHeader } from "../../shell/PageHeader";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { Breadcrumb } from "../bot/BotCanvas";
import { useLoadState } from "../bot/BotLayout";
import { ModelPicker } from "../settings/models/ModelPicker";

const home = "/w/$workspaceId/b/$botId/knowledge" as const;
const detail = "/w/$workspaceId/b/$botId/knowledge/$kbId" as const;
const tabs = ["Sources", "Documents", "Test search", "Settings"] as const;
type Tab = (typeof tabs)[number];

function useKnowledgeWrite<T>(action: (input: T) => Promise<unknown>, onSuccess?: () => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["knowledge"] });
      onSuccess?.();
    },
  });
}
function Pending() {
  return (
    <div role="status" aria-label="Loading knowledge">
      <Skeleton className="h-control-lg w-full" />
    </div>
  );
}
function More({ next, busy, load }: { next: boolean; busy: boolean; load: () => void }) {
  return next ? (
    <Button type="button" disabled={busy} onClick={load}>
      Load more
    </Button>
  ) : null;
}

export function KnowledgeScreen({ workspaceId, botId, kbId }: { workspaceId: string; botId: string; kbId?: string }) {
  const ready = useLoadState() === "ready";
  const base = useKnowledgeBase(workspaceId, botId, kbId);
  const bases = useKnowledgeBases(workspaceId, botId);
  const rows = bases.data?.pages.flatMap((p) => p.data) ?? [];
  const [adding, setAdding] = useState(false);
  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={ready} page="Knowledge" />}
      active="Knowledge"
      workspaceId={workspaceId}
      botId={botId}
    >
      <Page>
        {!kbId ? (
          <>
            <PageHeader
              title="Knowledge"
              actions={
                <Button variant="primary" onClick={() => setAdding(true)}>
                  New knowledge base
                </Button>
              }
            />
            {bases.isError ? (
              <ProblemBanner error={bases.error} />
            ) : bases.isPending ? (
              <Pending />
            ) : !rows.length ? (
              <EmptyState
                title="No knowledge bases yet"
                detail="Add a knowledge base to search your sources from this bot."
              />
            ) : (
              <Table label="Knowledge bases">
                <THead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Embedding model</Th>
                  </tr>
                </THead>
                <tbody>
                  {rows.map((b) => (
                    <Tr key={b.id}>
                      <Td>
                        <Link
                          className="text-accent"
                          dir="auto"
                          to={detail}
                          params={{ workspaceId, botId, kbId: b.id }}
                        >
                          {b.name}
                        </Link>
                      </Td>
                      <Td>{b.embeddingModel}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
            <More next={bases.hasNextPage} busy={bases.isFetchingNextPage} load={() => void bases.fetchNextPage()} />
            {adding && <NewBase workspaceId={workspaceId} botId={botId} close={() => setAdding(false)} />}
          </>
        ) : base.isError ? (
          <ProblemBanner error={base.error} />
        ) : base.data ? (
          <KnowledgeDetail workspaceId={workspaceId} botId={botId} key={base.data.id} base={base.data} />
        ) : (
          <Pending />
        )}
      </Page>
    </AppShell>
  );
}

function NewBase({ workspaceId, botId, close }: { workspaceId: string; botId: string; close: () => void }) {
  const models = useModels(workspaceId);
  const [name, setName] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const create = useKnowledgeWrite(async () => {
    const selected = models.data?.find((m) => m.id === model && m.kind === "embedding");
    if (!selected) return;
    return api("POST", knowledgePath(workspaceId, botId), {
      name,
      embeddingModel: `${selected.provider}:${selected.id}`,
    });
  }, close);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="New knowledge base"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            type="submit"
            form="new-knowledge"
            variant="primary"
            disabled={create.isPending || !model || !name.trim()}
          >
            Create knowledge base
          </Button>
        </>
      }
    >
      <form
        id="new-knowledge"
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined);
        }}
      >
        {models.isError && <ProblemBanner error={models.error} />}
        {create.isError && <ProblemBanner error={create.error} />}
        <Field label="Name">
          {(props) => (
            <Input
              {...props}
              dir="auto"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
          )}
        </Field>
        <Field label="Embedding model">
          {(props) => (
            <ModelPicker
              {...props}
              kind="embedding"
              models={models.data ?? []}
              value={model}
              onValueChange={setModel}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function KnowledgeDetail({ workspaceId, botId, base }: { workspaceId: string; botId: string; base: KnowledgeSummary }) {
  const [tab, setTab] = useState<Tab>("Sources");
  const path = `${knowledgePath(workspaceId, botId)}/${base.id}`;
  return (
    <>
      <Link to={home} params={{ workspaceId, botId }} className="text-accent">
        All knowledge bases
      </Link>
      <PageHeader title={<span dir="auto">{base.name}</span>} />
      <nav className="flex flex-wrap gap-5 border-b border-hairline" aria-label="Knowledge base sections">
        {tabs.map((t) => (
          <button
            type="button"
            key={t}
            aria-current={tab === t ? "page" : undefined}
            className={tabClasses(tab === t)}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      {tab === "Sources" && <Sources path={path} workspaceId={workspaceId} botId={botId} />}
      {tab === "Documents" && <Documents path={path} />}
      {tab === "Test search" && <Search path={path} />}
      {tab === "Settings" && (
        <Settings key={base.revision} path={path} workspaceId={workspaceId} botId={botId} base={base} />
      )}
    </>
  );
}

const stageLabels = {
  fetch: "Fetching",
  parse: "Parsing",
  normalise: "Normalising",
  chunk: "Chunking",
  embed: "Embedding",
  index: "Indexing",
} as const;

function displayStatus(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

function SourceStatus({ source }: { source: KnowledgeSourceSummary }) {
  const currentStage = Object.entries(stageLabels)
    .map(([stage, label]) => ({ label, stage: source.stages.find((item) => item.stage === stage) }))
    .find((item) => item.stage && item.stage.running > 0);
  const showProgress = source.documents > 0 && source.ready < source.documents;
  const label = currentStage?.label ?? "Indexed";
  const completed = currentStage?.stage?.done ?? source.ready;
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge>{displayStatus(source.status)}</Badge>
      {showProgress && (
        <>
          <span className="text-small text-secondary">
            {label} {completed} of {source.documents}
          </span>
          <progress aria-label={label} value={completed} max={source.documents} />
        </>
      )}
    </div>
  );
}

function Sources({ path, workspaceId, botId }: { path: string; workspaceId: string; botId: string }) {
  const sources = useKnowledgePage(`${path}/sources`, (raw) => KnowledgeSourceSummary.parse(raw), true, true);
  const rows = sources.data?.pages.flatMap((p) => p.data) ?? [];
  const [adding, setAdding] = useState(false);
  const [remove, setRemove] = useState<KnowledgeSourceSummary>();
  const sync = useKnowledgeWrite((id: string) => api("POST", `${path}/sources/${id}/sync`));
  const del = useKnowledgeWrite(
    (s: KnowledgeSourceSummary) => api("DELETE", `${path}/sources/${s.id}`, undefined, { "if-match": s.revision }),
    () => setRemove(undefined),
  );
  return (
    <>
      <div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add source
        </Button>
      </div>
      {sync.isError && <ProblemBanner error={sync.error} />}
      {sources.isError ? (
        <ProblemBanner error={sources.error} />
      ) : sources.isPending ? (
        <Pending />
      ) : !rows.length ? (
        <EmptyState title="No sources yet" detail="Add a file, text or a web address." />
      ) : (
        <Table label="Sources">
          <THead>
            <tr>
              <Th>Source</Th>
              <Th>Type</Th>
              <Th>Documents</Th>
              <Th>Status</Th>
              <Th>Synced</Th>
              <Th>Actions</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((s) => (
              <Tr key={s.id}>
                <Td>
                  <span dir="auto" className="whitespace-normal break-all">
                    {s.label}
                  </span>
                </Td>
                <Td>{displayStatus(s.kind)}</Td>
                <Td>{s.documents}</Td>
                <Td>
                  <SourceStatus source={s} />
                </Td>
                <Td>{s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleString() : "Pending"}</Td>
                <Td>
                  <div className="flex gap-3">
                    <Button disabled={sync.isPending} onClick={() => sync.mutate(s.id)}>
                      Sync
                    </Button>
                    <Button onClick={() => setRemove(s)}>Remove</Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <More next={sources.hasNextPage} busy={sources.isFetchingNextPage} load={() => void sources.fetchNextPage()} />
      {adding && <NewSource path={path} workspaceId={workspaceId} botId={botId} close={() => setAdding(false)} />}
      {remove && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setRemove(undefined);
          }}
          title="Remove source"
          description="Its indexed documents will be removed from this knowledge base."
          footer={
            <>
              <Button onClick={() => setRemove(undefined)}>Cancel</Button>
              <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(remove)}>
                Remove source
              </Button>
            </>
          }
        >
          {del.isError && <ProblemBanner error={del.error} />}
          <p dir="auto">{remove.label}</p>
        </Dialog>
      )}
    </>
  );
}

function NewSource({
  path,
  workspaceId,
  botId,
  close,
}: {
  path: string;
  workspaceId: string;
  botId: string;
  close: () => void;
}) {
  const [kind, setKind] = useState<KbSourceConfig["kind"]>("file");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File>();
  const create = useKnowledgeWrite(async () => {
    let source: unknown;
    if (kind === "file" && file) {
      const files = `/v1/workspaces/${workspaceId}/files`;
      const { file: record, upload } = CreateFileResponse.parse(
        await api("POST", files, {
          botId,
          purpose: "kb_source",
          name: file.name,
          mime: file.type || "application/octet-stream",
          size: file.size,
        }),
      );
      const put = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: file,
        credentials: "omit",
        redirect: "error",
      }).catch(() => undefined);
      if (!put?.ok) throw new ApiError(networkProblem());
      await api("POST", `${files}/${record.id}/complete`);
      source = { kind, fileId: record.id };
    } else if (kind === "text") source = { kind, title, text: content };
    else source = { kind, url: content.trim() };
    return api("POST", `${path}/sources`, { source });
  }, close);
  const valid =
    kind === "file"
      ? Boolean(file)
      : kind === "text"
        ? Boolean(title.trim() && content.trim())
        : Boolean(content.trim());
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !create.isPending) close();
      }}
      title="Add source"
      footer={
        <>
          <Button disabled={create.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="new-source" variant="primary" disabled={!valid || create.isPending}>
            Add source
          </Button>
        </>
      }
    >
      <form
        id="new-source"
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined);
        }}
      >
        {create.isError && <ProblemBanner error={create.error} />}
        <Field label="Source type">
          {(p) => (
            <Select
              {...p}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as KbSourceConfig["kind"]);
                setContent("");
              }}
            >
              <option value="file">File</option>
              <option value="text">Text</option>
              <option value="url">Web page</option>
              <option value="sitemap">Sitemap</option>
              <option value="crawl">Crawl</option>
            </Select>
          )}
        </Field>
        {kind === "file" ? (
          <Field label="File">
            {(p) => <Input {...p} type="file" onChange={(e) => setFile(e.target.files?.[0])} />}
          </Field>
        ) : kind === "text" ? (
          <>
            <Field label="Title">
              {(p) => (
                <Input
                  {...p}
                  dir="auto"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={200}
                />
              )}
            </Field>
            <Field label="Text">
              {(p) => (
                <Textarea
                  {...p}
                  dir="auto"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  required
                  maxLength={200_000}
                />
              )}
            </Field>
          </>
        ) : (
          <Field label="Web address">
            {(p) => (
              <Input
                {...p}
                type="url"
                dir="ltr"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
              />
            )}
          </Field>
        )}
      </form>
    </Dialog>
  );
}

function Documents({ path }: { path: string }) {
  const [id, setId] = useState<string>();
  const documents = useKnowledgePage(`${path}/documents`, (raw) => KnowledgeDocumentSummary.parse(raw), true, true);
  const rows = documents.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      {documents.isError ? (
        <ProblemBanner error={documents.error} />
      ) : documents.isPending ? (
        <Pending />
      ) : !rows.length ? (
        <EmptyState title="No documents yet" detail="Documents appear here after a source begins indexing." />
      ) : (
        <Table label="Documents">
          <THead>
            <tr>
              <Th>Document</Th>
              <Th>Status</Th>
              <Th>Language</Th>
              <Th>Tokens</Th>
              <Th>Parse quality</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((d) => (
              <Tr key={d.id}>
                <Td>
                  <Button variant="ghost" onClick={() => setId(d.id)}>
                    <span dir="auto">{d.title}</span>
                  </Button>
                </Td>
                <Td>
                  <Badge>{displayStatus(d.status)}</Badge>
                </Td>
                <Td>{d.language ?? "—"}</Td>
                <Td>{d.tokenCount}</Td>
                <Td>{d.quality === null ? "—" : `${Math.round(d.quality * 100)}%`}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <More
        next={documents.hasNextPage}
        busy={documents.isFetchingNextPage}
        load={() => void documents.fetchNextPage()}
      />
      {id && <DocumentDetail key={id} path={`${path}/documents/${id}`} close={() => setId(undefined)} />}
    </>
  );
}
function DocumentDetail({ path, close }: { path: string; close: () => void }) {
  const document = useQuery({
    queryKey: ["knowledge", path, "document"],
    queryFn: async () => KnowledgeDocumentDetail.parse(await api("GET", path)),
  });
  const chunks = useKnowledgePage(`${path}/chunks`, (raw) => KnowledgeChunk.parse(raw));
  return (
    <section className="flex flex-col gap-5" aria-label="Document preview">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-title" dir="auto">
          {document.data?.title ?? "Document"}
        </h2>
        <Button onClick={close}>Close document</Button>
      </div>
      {document.isError && <ProblemBanner error={document.error} />}
      {chunks.isError && <ProblemBanner error={chunks.error} />}
      {document.isPending || chunks.isPending ? (
        <Pending />
      ) : (
        <div className="grid grid-cols-2 gap-5">
          <section className="min-w-0">
            <h3 className="text-title">Parsed document</h3>
            <p dir="auto" className="whitespace-pre-wrap break-words">
              {document.data?.markdown ?? "Parsing is in progress."}
            </p>
          </section>
          <section className="min-w-0">
            <h3 className="text-title">Indexed chunks</h3>
            {chunks.data?.pages
              .flatMap((p) => p.data)
              .map((c) => (
                <article className="border-b border-hairline py-4" key={c.id}>
                  <h4 dir="auto" className="text-small text-secondary">
                    {c.headingPath.join(" / ") || `Chunk ${c.ordinal + 1}`}
                  </h4>
                  <p dir="auto" className="whitespace-pre-wrap break-words">
                    {c.text}
                  </p>
                </article>
              ))}
            <More next={chunks.hasNextPage} busy={chunks.isFetchingNextPage} load={() => void chunks.fetchNextPage()} />
          </section>
        </div>
      )}
    </section>
  );
}
function Search({ path }: { path: string }) {
  const [query, setQuery] = useState("");
  const [why, setWhy] = useState<string>();
  const search = useMutation({
    mutationFn: async () => TestKnowledgeResult.parse(await api("POST", `${path}/test-search`, { query })),
  });
  const trace = search.data?.trace;
  const selected = search.data?.passages.find((p) => p.chunkId === why);
  function submit(e: FormEvent) {
    e.preventDefault();
    setWhy(undefined);
    search.mutate();
  }
  return (
    <>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Search query">
          {(p) => (
            <Input
              {...p}
              dir="auto"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              required
              maxLength={8000}
            />
          )}
        </Field>
        <div>
          <Button type="submit" variant="primary" disabled={!query.trim() || search.isPending}>
            Search
          </Button>
        </div>
      </form>
      {search.isPending && <Pending />}
      {search.isError && <ProblemBanner error={search.error} />}
      {search.isSuccess &&
        (search.data.passages.length === 0 ? (
          <EmptyState
            title="No passages found"
            detail="Try a different query or check whether the sources are ready."
          />
        ) : (
          <Table label="Search results">
            <THead>
              <tr>
                <Th>Score</Th>
                <Th>Passage</Th>
                <Th>Document</Th>
                <Th>Why</Th>
              </tr>
            </THead>
            <tbody>
              {search.data.passages.map((p) => (
                <Tr key={p.chunkId}>
                  <Td>{p.score.toFixed(3)}</Td>
                  <Td>
                    <p dir="auto" className="whitespace-normal break-words">
                      {p.text}
                    </p>
                  </Td>
                  <Td>
                    <span dir="auto" className="whitespace-normal">
                      {p.title}
                    </span>
                  </Td>
                  <Td>
                    <Button onClick={() => setWhy(p.chunkId)}>Why</Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ))}
      {trace && selected && (
        <section className="flex flex-col gap-4" aria-label="Retrieval trace">
          <h2 className="text-title">Retrieval trace</h2>
          <p dir="auto">{trace.queryNormalised}</p>
          <Table label="Search stages">
            <THead>
              <tr>
                <Th>Stage</Th>
                <Th>Rank</Th>
                <Th>Score</Th>
              </tr>
            </THead>
            <tbody>
              {(["dense", "lexical", "fused", "reranked"] as const).map((stage) => {
                const list = trace[stage];
                const index = list.findIndex((x) => x.chunkId === selected.chunkId);
                return (
                  <Tr key={stage}>
                    <Td className="capitalize">{stage}</Td>
                    <Td>{index === -1 ? "—" : index + 1}</Td>
                    <Td>{list[index]?.score.toFixed(3) ?? "—"}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </section>
      )}
    </>
  );
}

function Settings({
  path,
  workspaceId,
  botId,
  base,
}: {
  path: string;
  workspaceId: string;
  botId: string;
  base: KnowledgeSummary;
}) {
  const nav = useNavigate();
  const [name, setName] = useState(base.name);
  const [description, setDescription] = useState(base.description);
  const [floor, setFloor] = useState(base.settings.minScore?.toString() ?? "");
  const [ocr, setOcr] = useState(base.settings.ocrModel ?? "");
  const [pages, setPages] = useState(base.settings.maxOcrPages?.toString() ?? "");
  const [confirm, setConfirm] = useState(false);
  const save = useKnowledgeWrite(async () => {
    const settings: KbSettings = {
      ...(floor ? { minScore: Number(floor) } : {}),
      ...(ocr.trim() ? { ocrModel: ocr.trim() } : {}),
      ...(pages ? { maxOcrPages: Number(pages) } : {}),
    };
    return api("PATCH", path, { name, description, settings }, { "if-match": base.revision });
  });
  const del = useKnowledgeWrite(
    () => api("DELETE", path, undefined, { "if-match": base.revision }),
    () => {
      void nav({ to: home, params: { workspaceId, botId } });
    },
  );
  return (
    <>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        {save.isError && <ProblemBanner error={save.error} />}
        <Field label="Name">
          {(p) => (
            <Input {...p} dir="auto" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          )}
        </Field>
        <Field label="Description">
          {(p) => (
            <Textarea
              {...p}
              dir="auto"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
          )}
        </Field>
        <Field label="Embedding model">{(p) => <Input {...p} value={base.embeddingModel} readOnly />}</Field>
        <Field label="Minimum rerank score">
          {(p) => <Input {...p} type="number" step="any" value={floor} onChange={(e) => setFloor(e.target.value)} />}
        </Field>
        <Field label="OCR model">{(p) => <Input {...p} value={ocr} onChange={(e) => setOcr(e.target.value)} />}</Field>
        <Field label="Maximum OCR pages">
          {(p) => (
            <Input {...p} type="number" min={1} max={500} value={pages} onChange={(e) => setPages(e.target.value)} />
          )}
        </Field>
        <div>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
      <div>
        <Button variant="danger" onClick={() => setConfirm(true)}>
          Delete knowledge base
        </Button>
      </div>
      {confirm && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirm(false);
          }}
          title="Delete knowledge base"
          description="This removes its sources, documents and indexed passages."
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate(undefined)}>
                Delete knowledge base
              </Button>
            </>
          }
        >
          {del.isError && <ProblemBanner error={del.error} />}
        </Dialog>
      )}
    </>
  );
}
