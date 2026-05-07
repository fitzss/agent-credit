/**
 * Dev/test session helper. NEVER deploy this to production.
 *
 * Builds a NextAuth JWT for the default operator, signed with NEXTAUTH_SECRET,
 * and returns a Cookie header value. The running app's middleware and route
 * guards accept it the same way they accept a browser-issued magic-link
 * session.
 *
 * Library use:
 *   import { operatorCookieHeader } from "./lib/test-session";
 *   const cookie = await operatorCookieHeader();
 *
 * CLI use:
 *   npx tsx scripts/lib/test-session.ts --print-cookie
 *   # prints "next-auth.session-token=..." to stdout, exits 0
 *   # exits nonzero if NEXTAUTH_SECRET is missing or the operator user is missing
 *
 * This helper lives under scripts/ and is NEVER imported from src/. It is not
 * bundled into next build. The app server never executes it.
 */
import { encode } from "next-auth/jwt";
import { PrismaClient } from "@prisma/client";

const COOKIE_NAME = "next-auth.session-token"; // dev (HTTP); prod uses __Secure- prefix

export async function operatorCookieHeader(client?: PrismaClient): Promise<string> {
  const ownsClient = !client;
  const prisma = client ?? new PrismaClient();
  try {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
      throw new Error("NEXTAUTH_SECRET is required for the test session helper");
    }
    const email =
      process.env.DEFAULT_OPERATOR_EMAIL ?? "operator@agent-credit.local";
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new Error(
        `operator user not found for email "${email}". Run: npm run backfill:operator`,
      );
    }
    const token = await encode({
      token: {
        sub: user.id,
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      secret,
      maxAge: 60 * 60, // 1 hour; tests run in seconds
    });
    return `${COOKIE_NAME}=${token}`;
  } finally {
    if (ownsClient) await prisma.$disconnect();
  }
}

async function mainCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--print-cookie")) {
    try {
      const cookie = await operatorCookieHeader();
      process.stdout.write(cookie + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `[test-session] ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  } else {
    process.stderr.write(
      "Usage: tsx scripts/lib/test-session.ts --print-cookie\n",
    );
    process.exit(2);
  }
}

if (require.main === module) {
  void mainCli();
}
