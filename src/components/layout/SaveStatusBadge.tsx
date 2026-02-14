import { AlertCircle, Check, Loader2 } from 'lucide-react';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SaveStatusBadgeProps {
  status: SaveStatus;
  isDirty: boolean;
}

export function SaveStatusBadge({ status, isDirty }: SaveStatusBadgeProps): JSX.Element | null {
  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-blue-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving...
      </span>
    );
  }

  if (status === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-green-400">
        <Check className="h-3 w-3" />
        Saved
      </span>
    );
  }

  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs text-red-400">
        <AlertCircle className="h-3 w-3" />
        Save failed
      </span>
    );
  }

  if (!isDirty) {
    return null;
  }

  return (
    <span className="flex items-center gap-1 text-xs text-yellow-500" title="Unsaved changes">
      <span className="h-2 w-2 rounded-full bg-yellow-500" />
      Unsaved
    </span>
  );
}
