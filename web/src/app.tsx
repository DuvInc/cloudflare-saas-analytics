import { useCallback, useEffect, useState } from "react";
import { api, features, setCsrf, type Me } from "@/lib/api";
import { useRoute } from "@/lib/route";
import { Shell } from "@/components/shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AiScreen } from "@/screens/ai";
import { FunnelsScreen } from "@/screens/funnels";
import { HealthScreen } from "@/screens/health";
import { LoginScreen } from "@/screens/login";
import { OverviewScreen } from "@/screens/overview";
import { PaymentsScreen } from "@/screens/payments";
import { PeopleScreen } from "@/screens/people";
import { ProductScreen } from "@/screens/product";
import { ReplaysScreen } from "@/screens/replays";
import { navigate } from "@/lib/route";

function Screen({ me }: { me: Me }) {
  const { path } = useRoute();
  let m: RegExpExecArray | null;
  if ((m = /^\/p\/([a-z0-9-]+)$/.exec(path))) return <ProductScreen key={m[1]} me={me} id={m[1]!} />;
  if (path === "/people") return <PeopleScreen me={me} />;
  if (path === "/funnels") return <FunnelsScreen me={me} />;
  if (path === "/ai") return <AiScreen me={me} />;
  if (path === "/replays") return <ReplaysScreen me={me} />;
  if ((m = /^\/r\/(rs_[A-Za-z0-9]+)$/.exec(path))) { navigate("/replays", { id: m[1]! }, { replace: true }); return null; }
  if (path === "/payments") return <PaymentsScreen me={me} />;
  if (path === "/health") return <HealthScreen />;
  return <OverviewScreen me={me} />;
}

export function App() {
  const [me, setMe] = useState<Me | null | "signed-out">(null);
  const boot = useCallback(async () => {
    if (new URLSearchParams(location.search).get("enroll")) return setMe("signed-out");
    /* One request: /api/me answers 401 when signed out (api() then shows the sign-in). */
    const m = await api<Me>("/api/me").catch(() => null);
    if (!m) return setMe("signed-out");
    setCsrf(m.csrf);
    features.ai = Boolean(m.ai);
    setMe(m);
  }, []);
  useEffect(() => {
    boot();
    const out = () => setMe("signed-out");
    window.addEventListener("csa:signed-out", out);
    return () => window.removeEventListener("csa:signed-out", out);
  }, [boot]);
  if (me === null) return <div className="min-h-svh bg-sidebar" />;
  if (me === "signed-out") return <LoginScreen onSignedIn={boot} />;
  return (
    <TooltipProvider delay={300}>
      <Shell me={me}><Screen me={me} /></Shell>
    </TooltipProvider>
  );
}
