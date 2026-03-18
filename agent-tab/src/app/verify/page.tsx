"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="text-zinc-500">Loading...</div>}>
      <VerifyContent />
    </Suspense>
  );
}

function VerifyContent() {
  const searchParams = useSearchParams();

  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [result, setResult] = useState<null | { valid: boolean; error?: string }>(null);
  const [verifying, setVerifying] = useState(false);
  const [secpLoaded, setSecpLoaded] = useState(false);

  // Pre-fill from query params (linked from credit statement page)
  useEffect(() => {
    const m = searchParams.get("message");
    const s = searchParams.get("signature");
    const k = searchParams.get("publicKey");
    if (m) setMessage(m);
    if (s) setSignature(s);
    if (k) setPublicKey(k);
  }, [searchParams]);

  // Load secp256k1 in browser
  useEffect(() => {
    import("@noble/secp256k1").then(() => setSecpLoaded(true));
  }, []);

  const verify = async () => {
    setVerifying(true);
    setResult(null);

    try {
      const secp = await import("@noble/secp256k1");

      // Hash the canonical message with SHA-256 (browser-side)
      const msgBytes = new TextEncoder().encode(message);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBytes);
      const msgHash = new Uint8Array(hashBuffer);

      const sigBytes = secp.etc.hexToBytes(signature);
      const pubKeyBytes = secp.etc.hexToBytes(publicKey);

      const valid = secp.verify(sigBytes, msgHash, pubKeyBytes);
      setResult({ valid });
    } catch (e) {
      setResult({ valid: false, error: String(e) });
    }

    setVerifying(false);
  };

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <Link href="/" className="text-sm text-zinc-500 hover:text-white transition-colors">
          &larr; Back
        </Link>
        <h1 className="text-3xl font-bold mt-2">Verify Obligation</h1>
        <p className="text-zinc-400 mt-1">
          Browser-side signature verification
        </p>
      </div>

      {/* Trust boundary notice */}
      <div className="border border-zinc-700 rounded-lg p-4 bg-zinc-900 text-sm space-y-2">
        <p className="font-medium text-zinc-300">What this verification proves</p>
        <p className="text-zinc-400">
          This page verifies a secp256k1 ECDSA signature entirely in your browser using{" "}
          <span className="font-mono text-zinc-300">@noble/secp256k1</span>. No server
          requests are made during verification.
        </p>
        <p className="text-zinc-400">
          A valid signature confirms the <span className="text-zinc-300">integrity</span> of
          the obligation record: the cumulative amount, version, counterparty
          identities, and timestamp are exactly what was signed. The canonical message
          has not been modified since signing.
        </p>
        <p className="font-medium text-zinc-300 mt-3">What this does not prove in v1</p>
        <p className="text-zinc-400">
          In this version, debtor signing keys are managed by the tracker application
          for operational convenience. Verification confirms that the signature matches
          the stated public key and message, but does not confirm that the debtor
          independently controlled the signing key. Full debtor-side key custody,
          where the debtor holds their own private key and signs locally, is a
          planned upgrade that would provide that stronger property.
        </p>
      </div>

      {/* Verification form */}
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Canonical Message</label>
          <textarea
            value={message}
            onChange={(e) => { setMessage(e.target.value); setResult(null); }}
            rows={3}
            placeholder="agentab:v1|debtorPubKey|creditorPubKey|amount|version|timestamp"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-500 resize-none"
          />
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Signature (hex)</label>
          <textarea
            value={signature}
            onChange={(e) => { setSignature(e.target.value); setResult(null); }}
            rows={2}
            placeholder="ECDSA compact signature in hex"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-500 resize-none"
          />
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Debtor Public Key (hex)</label>
          <input
            type="text"
            value={publicKey}
            onChange={(e) => { setPublicKey(e.target.value); setResult(null); }}
            placeholder="Compressed secp256k1 public key in hex"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-500"
          />
        </div>

        <button
          onClick={verify}
          disabled={!message || !signature || !publicKey || verifying || !secpLoaded}
          className="px-6 py-2.5 bg-white text-black rounded text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {verifying ? "Verifying..." : !secpLoaded ? "Loading crypto..." : "Verify Signature"}
        </button>
      </div>

      {/* Result */}
      {result && (
        <div
          className={`border rounded-lg p-5 ${
            result.valid
              ? "border-green-800 bg-green-900/20"
              : "border-red-800 bg-red-900/20"
          }`}
        >
          <div className="flex items-center gap-3">
            <span
              className={`w-3 h-3 rounded-full ${
                result.valid ? "bg-green-400" : "bg-red-400"
              }`}
            />
            <span className={`font-medium ${result.valid ? "text-green-400" : "text-red-400"}`}>
              {result.valid ? "Signature Valid" : "Signature Invalid"}
            </span>
          </div>
          {result.valid && (
            <p className="text-sm text-zinc-400 mt-2">
              The signature is cryptographically valid for the given message and public key.
              This was verified entirely in your browser.
            </p>
          )}
          {result.error && (
            <p className="text-sm text-red-400 mt-2 font-mono">{result.error}</p>
          )}
        </div>
      )}

      {/* How it works */}
      <div className="text-sm text-zinc-500 space-y-1">
        <p className="font-medium text-zinc-400">How verification works</p>
        <p>1. The canonical message is hashed with SHA-256 in your browser</p>
        <p>2. The ECDSA signature is verified against the hash and public key</p>
        <p>3. Uses <span className="font-mono">@noble/secp256k1</span> (same curve as Ergo)</p>
        <p>4. No data is sent to any server during this process</p>
      </div>
    </div>
  );
}
