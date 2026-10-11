import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[Atlas Soft Water ErrorBoundary]', error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#F9F6F0] text-[#0F172A] flex items-center justify-center p-8">
          <div className="max-w-xl w-full bg-white border border-red-300 rounded-lg p-8">
            <div className="flex items-center gap-3 text-red-700 mb-4">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h1 className="text-xl font-bold">Erreur système détectée</h1>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Une exception inattendue a été interceptée par le garde-fou d&apos;intégrité. Vos
              données IndexedDB locales sont préservées.
            </p>
            <pre className="bg-slate-900 text-red-200 p-4 rounded text-xs font-mono overflow-x-auto mb-6">
              {this.state.error?.message || 'Erreur inconnue'}
            </pre>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#0F172A] text-white text-sm font-medium rounded-md hover:bg-slate-800 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Recharger l&apos;application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
