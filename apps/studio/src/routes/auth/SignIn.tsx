import { Link, useNavigate } from "@tanstack/react-router";
import { Button, Field, Input } from "@wakeel/ui";
import { type FormEvent, useState } from "react";
import { fieldErrors } from "../../api/client";
import { useSignIn, useSignUp } from "../../api/queries";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { AuthLayout } from "./AuthLayout";

const linkClass = "text-body font-medium text-accent-text hover:underline";

/** After signing in, go back to where the user was sent from (an invitation link), else home. */
function useAfterAuth() {
  const navigate = useNavigate();
  return (redirect: string | undefined) => {
    const safe = redirect?.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
    void navigate({ to: safe });
  };
}

export function SignIn({ redirect }: { redirect?: string }) {
  const signIn = useSignIn();
  const after = useAfterAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const errors = fieldErrors(signIn.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate({ email, password }, { onSuccess: () => after(redirect) });
  };

  return (
    <AuthLayout heading="Sign in">
      <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {signIn.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={signIn.error} /> : null}
        <Field label="Email" error={errors["email"]}>
          {(p) => (
            <Input
              {...p}
              size="large"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password" error={errors["password"]}>
          {(p) => (
            <Input
              {...p}
              size="large"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="large" disabled={signIn.isPending}>
          Sign in
        </Button>
      </form>
      <p className="text-body text-secondary">
        New here?{" "}
        <Link to="/sign-up" search={redirect === undefined ? {} : { redirect }} className={linkClass}>
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}

export function SignUp({ redirect }: { redirect?: string }) {
  const signUp = useSignUp();
  const after = useAfterAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const errors = fieldErrors(signUp.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    signUp.mutate({ name, email, password }, { onSuccess: () => after(redirect) });
  };

  return (
    <AuthLayout heading="Create an account">
      <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
        {signUp.isError && Object.keys(errors).length === 0 ? <ProblemBanner error={signUp.error} /> : null}
        <Field label="Name" error={errors["name"]}>
          {(p) => (
            <Input
              {...p}
              size="large"
              dir="auto"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Email" error={errors["email"]}>
          {(p) => (
            <Input
              {...p}
              size="large"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label="Password" help="At least 8 characters." error={errors["password"]}>
          {(p) => (
            <Input
              {...p}
              size="large"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="large" disabled={signUp.isPending}>
          Create account
        </Button>
      </form>
      <p className="text-body text-secondary">
        Have an account?{" "}
        <Link to="/sign-in" search={redirect === undefined ? {} : { redirect }} className={linkClass}>
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
