import { useNavigate } from "@tanstack/react-router";
import { Button } from "@wakeel/ui";
import { useAcceptInvitation } from "../../api/queries";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { AuthLayout } from "./AuthLayout";

/** `/invite/<token>`: a signed-in user joins the workspace that invited their email. */
export function AcceptInvite({ token }: { token: string }) {
  const accept = useAcceptInvitation();
  const navigate = useNavigate();
  return (
    <AuthLayout heading="Join workspace">
      <p className="text-body text-secondary">
        You were invited to a workspace. Joining gives you the role it was sent with.
      </p>
      {accept.isError ? <ProblemBanner error={accept.error} /> : null}
      <Button
        variant="primary"
        size="large"
        disabled={accept.isPending}
        onClick={() =>
          accept.mutate(token, {
            onSuccess: (w) => void navigate({ to: "/w/$workspaceId", params: { workspaceId: w.id } }),
          })
        }
      >
        Join workspace
      </Button>
    </AuthLayout>
  );
}
