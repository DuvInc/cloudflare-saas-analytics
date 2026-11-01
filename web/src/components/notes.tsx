import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function ErrorNote({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center gap-x-3">
        <span>{error}</span>
        {onRetry && <button type="button" onClick={onRetry} className="font-medium underline underline-offset-4 hover:no-underline">Retry</button>}
      </AlertDescription>
    </Alert>
  );
}
