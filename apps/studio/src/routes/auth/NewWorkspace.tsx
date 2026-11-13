import { useNavigate } from "@tanstack/react-router";
import { Button, Field, Input } from "@wakeel/ui";
import { type FormEvent, useState } from "react";
import { fieldErrors } from "../../api/client";
import { useCreateWorkspace } from "../../api/queries";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { AuthLayout } from "./AuthLayout";

/** Lower-case letters, digits and dashes from a name; Arabic names leave it for the user to fill. */
export function slugFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** First run: a signed-in user with no workspace creates one and becomes its owner. */
export function NewWorkspace() {
  const create = useCreateWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const errors = fieldErrors(create.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { name, slug },
      { onSuccess: (w) => void navigate({ to: "/w/$workspaceId", params: { workspaceId: w.id } }) },
    );
  };

  return (
    <AuthLayout heading="New workspace">
      <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {create.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={create.error} /> : null}
        <Field label="Name" help="Usually your company or team." error={errors["name"]}>
          {(p) => (
            <Input
              {...p}
              size="large"
              dir="auto"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) setSlug(slugFrom(e.target.value));
              }}
            />
          )}
        </Field>
        <Field label="Address" help="Lower-case letters, digits and dashes." error={errors["slug"]}>
          {(p) => (
            <Input
              {...p}
              size="large"
              dir="ltr"
              className="font-mono"
              required
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="large" disabled={create.isPending}>
          Create workspace
        </Button>
      </form>
    </AuthLayout>
  );
}
