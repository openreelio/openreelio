import { useState, useCallback, useEffect } from 'react';
import { X, Download, FileText, FileCode } from 'lucide-react';
import { useCaptionExport, type CaptionExportFormat } from '@/hooks/useCaptionExport';
import type { Caption } from '@/types';

export interface CaptionExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  captions: Caption[];
  defaultName?: string;
}

export function CaptionExportDialog({
  isOpen,
  onClose,
  captions,
  defaultName = 'captions',
}: CaptionExportDialogProps) {
  const { exportToFile, isExporting, error } = useCaptionExport();
  const [format, setFormat] = useState<CaptionExportFormat>('srt');
  const [filename, setFilename] = useState(defaultName);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setFilename(defaultName);
      setFormat('srt');
    }
  }, [isOpen, defaultName]);

  const handleExport = useCallback(async () => {
    const success = await exportToFile(captions, format, filename);
    if (success) {
      onClose();
    }
  }, [exportToFile, captions, format, filename, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <Download className="w-5 h-5 text-primary-500" />
            <h2 className="text-lg font-semibold text-white">Export Captions</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isExporting}
            className="p-1 rounded hover:bg-gray-800 transition-colors text-gray-400 hover:text-white disabled:opacity-50"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-6 space-y-6">
          {error && (
            <div className="p-3 bg-red-900/30 border border-red-800 rounded text-red-200 text-sm">
              {error}
            </div>
          )}

          {/* Filename */}
          <div>
            <label htmlFor="filename" className="block text-sm font-medium text-gray-300 mb-2">
              Filename
            </label>
            <input
              id="filename"
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-primary-500"
              placeholder="Enter filename"
              disabled={isExporting}
            />
          </div>

          {/* Format Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Format</label>
            <div className="grid grid-cols-2 gap-3">
              <label
                className={`
                  relative flex flex-col items-center gap-2 p-4 rounded-lg border cursor-pointer transition-all
                  ${
                    format === 'srt'
                      ? 'bg-primary-500/20 border-primary-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-750 hover:border-gray-600'
                  }
                `}
              >
                <input
                  type="radio"
                  name="format"
                  value="srt"
                  checked={format === 'srt'}
                  onChange={() => setFormat('srt')}
                  className="sr-only"
                  disabled={isExporting}
                />
                <FileText
                  className={`w-8 h-8 ${format === 'srt' ? 'text-primary-400' : 'text-gray-500'}`}
                />
                <span className="text-sm font-medium">SubRip (.srt)</span>
              </label>

              <label
                className={`
                  relative flex flex-col items-center gap-2 p-4 rounded-lg border cursor-pointer transition-all
                  ${
                    format === 'vtt'
                      ? 'bg-primary-500/20 border-primary-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-750 hover:border-gray-600'
                  }
                `}
              >
                <input
                  type="radio"
                  name="format"
                  value="vtt"
                  checked={format === 'vtt'}
                  onChange={() => setFormat('vtt')}
                  className="sr-only"
                  disabled={isExporting}
                />
                <FileCode
                  className={`w-8 h-8 ${format === 'vtt' ? 'text-primary-400' : 'text-gray-500'}`}
                />
                <span className="text-sm font-medium">WebVTT (.vtt)</span>
              </label>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-700 bg-gray-800/50">
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={isExporting || !filename.trim()}
            className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isExporting ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Export
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
