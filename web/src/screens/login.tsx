/* Passkey sign-in, or registering this device from an enrolment link (?enroll=...). */
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Mark } from "@/components/logo";
import { Button } from "@/components/ui/button";

async function post(path: string, body: unknown) {
  const r = await (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  if (r.error) throw new Error(r.error.message);
  return r;
}

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const enroll = new URLSearchParams(location.search).get("enroll");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setBusy(true); setError("");
    try {
      if (!browserSupportsWebAuthn()) throw new Error("This browser does not support passkeys.");
      if (enroll) {
        const o = await post("/api/auth/register/options", { code: enroll });
        await post("/api/auth/register/verify", { challengeId: o.challengeId, response: await startRegistration({ optionsJSON: o.options }) });
        history.replaceState(null, "", "/");
      } else {
        const o = await post("/api/auth/login/options", {});
        await post("/api/auth/login/verify", { challengeId: o.challengeId, response: await startAuthentication({ optionsJSON: o.options }) });
      }
      onSignedIn();
    } catch (e) {
      const m = (e as Error).message;
      setError(/NotAllowed|cancel|timed out/i.test(m) ? "Sign-in cancelled." : m);
    } finally { setBusy(false); }
  }
  return (
    <main className="flex min-h-svh items-center justify-center bg-sidebar p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl border bg-background px-8 py-10 text-center">
        <Mark className="size-10" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">SaaS Analytics</h1>
          <p className="text-sm text-muted-foreground">{enroll ? "Register this device" : "Private access"}</p>
        </div>
        <Button className="w-full" size="lg" onClick={go} disabled={busy}>
          <KeyRound data-icon="inline-start" />{enroll ? "Create a passkey" : "Continue with a passkey"}
        </Button>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </main>
  );
}
