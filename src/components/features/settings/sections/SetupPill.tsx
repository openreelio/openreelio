import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

/** Small status pill shown for install/auth/tooling readiness states. */
export function SetupPill({
  label,
  ready,
  pending = false,
}: {
  label: string;
  ready: boolean;
  pending?: boolean;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
        ready
          ? 'border-green-600/30 bg-green-600/10 text-green-300'
          : 'border-editor-border bg-editor-bg text-editor-text-muted'
      }`}
    >
      {pending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : ready ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <AlertCircle className="h-3 w-3" />
      )}
      {label}
    </span>
  );
}

export default SetupPill;
