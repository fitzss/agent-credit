"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

function LoginForm() {
  const search = useSearchParams();
  const callbackUrl = search.get("callbackUrl") ?? "/";
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await signIn("email", { email, callbackUrl, redirect: false });
      setSubmitted(true);
    } catch {
      setError("Could not send the magic link. Check the dev server logs.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100 px-6">
      <div className="w-full max-w-sm border border-zinc-800 rounded-lg p-6">
        <h1 className="text-xl font-semibold mb-1">Sign in to Agent Credit</h1>
        <p className="text-sm text-zinc-400 mb-6">
          Enter your email and we will send you a sign-in link.
        </p>

        {submitted ? (
          <div className="space-y-3 text-sm">
            <p className="text-green-400">
              Magic link sent. Check your email.
            </p>
            <p className="text-zinc-500">
              In dev mode the link is printed to the Next.js terminal.
              Copy it and paste it into your browser to complete sign-in.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm text-zinc-400 mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-600"
              />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50 rounded px-3 py-2 text-sm font-medium transition-colors"
            >
              {submitting ? "Sending…" : "Send sign-in link"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
