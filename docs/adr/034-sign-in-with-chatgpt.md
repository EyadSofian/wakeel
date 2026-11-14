# ADR-034 — "Sign in with ChatGPT" as a model source

Status: proposed · Date: 2026-11-14 · Decision owner: Eyad

## Context

Eyad asked whether a workspace could connect its ChatGPT account and run its bots on that account's
ChatGPT plan allowance instead of an API key, as some open-source desktop apps now do. That would let
a client with a ChatGPT Plus or Pro plan try the platform without buying API credits.

OpenAI launched this officially at DevDay on 2026-09-29 as **Sign in with ChatGPT** (plan usage).
What its developer docs say (read 2026-11-14):

- **Who may use it.** "Open-source projects, personal projects that run locally, and selected private
  apps." A paid or remotely hosted app must join the waitlist / interest form before offering it
  (developers.openai.com/cookbook/articles/sign-in-with-chatgpt; form at
  openai.com/form/sign-in-with-chatgpt-interest/).
- **Whose usage.** Each issued client id "is bound to the authenticated user and the workspace selected
  during registration" (developers.openai.com/siwc/token-sharing-open-source). Secondary coverage of the
  Sign in with ChatGPT Terms (openai.com/policies/sign-in-with-chatgpt-terms/, which returned 403 to
  our fetcher, so not read first-hand) reports that they forbid pooling, reselling or sharing plan
  usage and **using one user's subscription to fulfil another user's requests**.
- **Mechanics.** OAuth with PKCE against `auth.openai.com`, a dynamically registered client id, scopes
  including `offline_access` and `chatgpt.tokens.use.direct`, hour-long access tokens with rotating
  refresh tokens; requests go to the public Responses API (`POST /v1/responses`, `stream: true`,
  `store: false`). Usage-limit errors are `subscription_sharing_usage_limit_exceeded` (429),
  `…_usage_unavailable` (503), `…_user_not_eligible` (403), `…_invalid_user` (401).

The platform is a hosted, multi-tenant service. Its bots answer **end customers** of a workspace, not
the person who owns the ChatGPT account.

## Options

1. **Build it now for bot traffic.** A workspace owner signs in with ChatGPT; the worker uses the
   stored token for every conversation. Rejected: the platform is a hosted app that is not on OpenAI's
   approved list, and serving a business's customers from the owner's personal plan is the "one
   user's subscription for another user's requests" case the terms are reported to forbid. It would
   put every tenant's account at risk of suspension, and the platform with it.
2. **Builder-only use after approval.** Once OpenAI approves the platform as a hosted app, let a builder
   sign in with ChatGPT for traffic that is genuinely theirs: the emulator, evals, and Studio helpers
   such as drafting instructions. Live conversations still need an API key. This fits the documented
   model (the signed-in person is the person using it) and would still lower the cost of trying the
   product.
3. **Do nothing.** API keys only (BYOK, ADR-010).

## Recommendation

Option 2, gated on approval:

1. Eyad submits the interest form for the hosted platform now (it names the company and the use, so it
   is his to send).
2. Until OpenAI answers, nothing is built; Settings → Models keeps API keys only.
3. If approved, a new provider kind `openai_chatgpt_plan` joins the model layer (ADR-010) with: the
   OAuth flow in the Studio, tokens stored with envelope encryption (task 1.5) per **member**, not per
   workspace; use restricted by the turn's mode to `emulator` and `eval` (the mode tag from task 11.1);
   the four error codes mapped to `AppError` codes with a fix that links to ChatGPT → Settings → Usage;
   no automatic fallback to the plan when an API key fails.

## Consequences

- Live bots keep requiring an API key; the pricing and BYOK assumptions in open question #5 are
  unchanged.
- If approval never comes, the cost is one form.
- If OpenAI later publishes terms that allow serving third parties from a business plan (for example a
  ChatGPT Business or Enterprise product), this ADR is revisited; option 1 stays rejected until then.
