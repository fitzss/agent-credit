import type { NextAuthOptions, Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import EmailProvider from "next-auth/providers/email";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const isProd = process.env.NODE_ENV === "production";

// Session strategy: JWT (intentional, see comment on `session.strategy` below).

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  // ---------------------------------------------------------------------------
  // Session strategy is JWT (intentional).
  //
  // Why JWT and not database sessions:
  //   - next-auth/middleware (`withAuth`) reads the session at the Next edge via
  //     `getToken()`, which decodes a JWT cookie. With database sessions, the
  //     cookie is an opaque UUID the middleware cannot decode, so even logged-in
  //     users get redirected to /login.
  //   - Production envelope foundation prefers stateless sessions: middleware
  //     gating works without a DB roundtrip on every page load.
  //
  // What this means for the schema:
  //   - The Prisma adapter still owns User, Account, and VerificationToken
  //     (magic-link tokens land in VerificationToken until consumed).
  //   - The Session table exists for adapter compatibility / future strategy
  //     changes but is NOT the active session store. No rows are written to it
  //     while strategy is "jwt".
  //
  // To revisit later: if we move to OAuth providers that benefit from
  // server-side revocation, switch `strategy` to "database" and adopt a
  // middleware approach that does a DB roundtrip (Next App Router server
  // actions, or a per-route guard). Tracked as a future hardening item.
  // ---------------------------------------------------------------------------
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    EmailProvider({
      // The `server` value below is only used when sendVerificationRequest
      // (overridden) does not short-circuit. In dev with no SMTP, the override
      // logs the link to stdout; in production with SMTP, the override creates
      // a transport from EMAIL_SERVER. The default placeholder satisfies the
      // EmailProvider type without performing any SMTP work at startup.
      server: process.env.EMAIL_SERVER ?? { host: "localhost", port: 0 },
      from: process.env.EMAIL_FROM ?? "noreply@agent-credit.local",
      sendVerificationRequest: async ({ identifier, url }) => {
        const smtpConfigured = !!process.env.EMAIL_SERVER;

        // Production fail-closed: never log magic links in production. If
        // EMAIL_SERVER is unset, refuse to send. The login page surfaces the
        // resulting EmailSignin error to the user; operators see a clear
        // server log explaining the missing config.
        if (isProd && !smtpConfigured) {
          console.error(
            "[auth] EMAIL_SERVER is not configured in production. " +
              "Refusing to send magic link. Set EMAIL_SERVER and EMAIL_FROM, " +
              "then redeploy.",
          );
          throw new Error(
            "Email sign-in is not configured on this server. Contact an operator.",
          );
        }

        // Local dev: console-log the magic link. No SMTP needed.
        if (!smtpConfigured) {
          console.log("\n========================================");
          console.log("  Magic link for:", identifier);
          console.log("  ", url);
          console.log("========================================\n");
          return;
        }

        // Real SMTP path (production with EMAIL_SERVER configured).
        const { createTransport } = await import("nodemailer");
        const transport = createTransport(process.env.EMAIL_SERVER!);
        await transport.sendMail({
          to: identifier,
          from: process.env.EMAIL_FROM ?? "noreply@agent-credit.local",
          subject: "Sign in to Agent Credit",
          text: `Sign in: ${url}`,
          html: `<p>Sign in: <a href="${url}">${url}</a></p>`,
        });
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // On initial sign-in, `user` is the freshly-loaded adapter user. Persist
      // the id and role into the JWT so subsequent requests can read them.
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role ?? "customer";
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as SessionUser).id = token.id as string;
        (session.user as SessionUser).role = (token.role as string) ?? "customer";
      }
      return session;
    },
  },
};

export type SessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  role: "operator" | "customer" | string;
};

export type AppSession = Session & { user: SessionUser };

export async function getSession(): Promise<AppSession | null> {
  const s = await getServerSession(authOptions);
  return s as AppSession | null;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export async function requireSession(): Promise<SessionUser> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new HttpError(401, "unauthenticated");
  }
  return session.user;
}

export async function requireOperator(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== "operator") {
    throw new HttpError(403, "operator role required");
  }
  return user;
}

export async function requireCustomerOwned(customerId: string): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role === "operator") return user;
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { ownerUserId: true },
  });
  if (!customer || customer.ownerUserId !== user.id) {
    throw new HttpError(403, "customer not owned by current user");
  }
  return user;
}

// Customer IDs that the current user owns. Returns null for operators
// (meaning "no scope filter — see everything"). Returns possibly-empty
// array for customer-role users.
export async function ownedCustomerIds(
  user: SessionUser,
): Promise<string[] | null> {
  if (user.role === "operator") return null;
  const customers = await prisma.customer.findMany({
    where: { ownerUserId: user.id },
    select: { id: true },
  });
  return customers.map((c) => c.id);
}

// Convert HttpError thrown by require* helpers into a JSON NextResponse.
// Re-throws anything else so the framework can surface it as a 500.
export function authErrorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  throw e;
}
