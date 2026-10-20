'use client';
import { Component, type ReactNode } from 'react';

// R-1c: Catches any render-time throw in the subtree so one bad card /
// state transition doesn't blank the whole page. React still needs a class
// component for this — hooks don't have an error-boundary equivalent.
//
// Scope: wrap the room page's main content. Lobby/landing are simple
// enough that a crash there is a signal, not a mystery.
interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, errorMessage: '' };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, errorMessage: err.message };
  }

  componentDidCatch(err: Error, info: { componentStack?: string | null }) {
    // Log to console — this'll show up in the user's dev tools if they open
    // them. Prod server log would need a /log endpoint; defer for now.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', err, info.componentStack);
  }

  reset = () => this.setState({ hasError: false, errorMessage: '' });

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="rounded-lg border border-loss/40 bg-loss/10 p-4 text-sm">
        <div className="mb-2 font-bold text-loss">畫面載入出錯</div>
        <div className="mb-3 text-bone/70">
          {this.state.errorMessage || '請重新整理頁面;若持續發生,請告訴管理員。'}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded border border-bone/30 px-3 py-1.5 text-xs hover:bg-white/5"
          >
            重試
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded bg-brass px-3 py-1.5 text-xs font-bold text-rail"
          >
            重新載入頁面
          </button>
        </div>
      </div>
    );
  }
}
