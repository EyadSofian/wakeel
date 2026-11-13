import { Banner } from "@wakeel/ui";
import { ApiError } from "../api/client";

/** A failed request, as the api said it: what happened and how to fix it (design system §3.3). */
export function ProblemBanner({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  if (error instanceof ApiError) {
    return (
      <Banner tone="error" title={error.problem.title}>
        {error.problem.fix}
      </Banner>
    );
  }
  return (
    <Banner tone="error" title="Something went wrong on our side">
      Reload the page and try again.
    </Banner>
  );
}
