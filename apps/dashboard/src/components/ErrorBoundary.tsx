// Catches an error thrown while rendering a page. Without it React unmounts the whole app and the screen goes blank;
// with it, only the page area shows the problem, and the navigation stays usable.
// (Error boundaries still have to be class components: there is no hook for componentDidCatch.)
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Changing this value (e.g. the current path) clears the error, so navigating away recovers. */
  resetKey: string;
}

interface State {
  error: Error | null;
  resetKey: string;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="panel max-w-[640px] px-5 py-4">
        <h1 className="section-title">This page could not be shown</h1>
        <p className="mt-1 text-sm text-ink-2">
          Something unexpected went wrong while drawing it ({this.state.error.message}). The rest of the dashboard still
          works; reload the page to try again.
        </p>
        <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
