import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Agent Tab",
  description: "Programmable credit for agent tool markets",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <nav className="border-b border-zinc-800 px-6 py-4">
          <div className="max-w-6xl mx-auto flex items-center gap-8">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Agent Tab
            </Link>
            <div className="flex gap-6 text-sm text-zinc-400">
              <Link href="/" className="hover:text-white transition-colors">
                Overview
              </Link>
              <Link href="/verify" className="hover:text-white transition-colors">
                Verify
              </Link>
            </div>
          </div>
        </nav>
        <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
