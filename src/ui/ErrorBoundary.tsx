/**
 * Error boundary.
 *
 * A throw inside the canvas used to unmount the tree and leave a black
 * rectangle with no way out. This catches it and offers the two things that
 * actually help: go back to the title with your progress intact, or reload.
 *
 * The fallback is deliberately self-contained — plain elements, inline
 * classes, no shared Button (which plays a sound), no store reads at render
 * time. A recovery screen that can itself throw is not a recovery screen.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Headline for the recovery screen. */
  title?: string;
  /** One sentence under the headline, in the game's voice. */
  body?: string;
  /** Rendered instead of "Back to the title" when the caller can recover in place. */
  onRecover?: () => void;
  recoverLabel?: string;
  /**
   * When any value here changes, the boundary clears itself. Screen routing
   * passes the current screen so leaving a broken screen un-breaks it.
   */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const reload = (): void => {
  try {
    window.location.reload();
  } catch {
    // Nothing further to offer; the message on screen still stands.
  }
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack is the only artefact anyone can act on later, so keep it.
    console.error('[tiny convoy] interface error', error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private recover = (): void => {
    const { onRecover } = this.props;
    this.setState({ error: null });
    try {
      onRecover?.();
    } catch {
      reload();
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const {
      title = 'The convoy has stopped',
      body = 'Something in the interface gave out. Your scrap, blueprints and history are saved on this machine and are not affected.',
      recoverLabel = 'Back to the title',
      onRecover,
    } = this.props;

    const detail = typeof error.message === 'string' && error.message.length > 0 ? error.message : 'No detail was reported.';

    return (
      <div className="absolute inset-0 z-[60] flex items-center justify-center bg-ink p-6">
        <div
          role="alert"
          className="w-full max-w-md rounded-[14px] border border-line bg-panel px-6 py-6 text-left"
        >
          <div className="text-[0.66rem] font-semibold uppercase tracking-[0.14em] text-faint">Tiny Convoy</div>
          <h2 className="mt-2 text-2xl text-cream">{title}</h2>
          <p className="mt-3 text-sm leading-relaxed text-sand">{body}</p>

          <div className="mt-5 flex flex-wrap gap-2">
            {onRecover && (
              <button
                type="button"
                onClick={this.recover}
                className="rounded-xl border border-ember bg-ember px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-ember-soft"
              >
                {recoverLabel}
              </button>
            )}
            <button
              type="button"
              onClick={reload}
              className="rounded-xl border border-line bg-panel-2 px-5 py-2.5 text-sm font-medium text-cream transition-colors hover:border-sand/50"
            >
              Reload the game
            </button>
          </div>

          <details className="mt-5 text-xs text-muted">
            <summary className="cursor-pointer text-faint">What went wrong</summary>
            <p className="mt-2 break-words font-mono text-[0.68rem] leading-relaxed text-muted">{detail}</p>
          </details>
        </div>
      </div>
    );
  }
}
