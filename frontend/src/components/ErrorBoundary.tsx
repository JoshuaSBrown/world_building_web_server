import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * What the app shows when it breaks.
 *
 * React unmounts the whole tree when a render or an effect throws, so without
 * this the page goes **blank** — the least informative failure a display can
 * have, and indistinguishable from a run that produced nothing. The same rule
 * the rest of this repo follows applies to the viewer itself: say what is
 * missing, and never present absence as if it were a result.
 *
 * The message and the stack are shown verbatim. A viewer that swallowed them
 * would be asking its user to guess.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; stack: string | null }
> {
  state: { error: Error | null; stack: string | null } = { error: null, stack: null };

  static getDerivedStateFromError(error: Error) {
    return { error, stack: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Also to the console, where a developer's tooling can reach it.
    console.error("viewer crashed:", error, info.componentStack);
    this.setState({ error, stack: info.componentStack ?? null });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fallback" role="alert">
        <h2>The viewer stopped</h2>
        <p>
          Something threw while drawing. This is a fault in the display, not in
          the run — whatever the simulation recorded is still on disk.
        </p>
        <pre className="crash">{error.message}</pre>
        {stack ? <pre className="crash crash--stack">{stack.trim()}</pre> : null}
        <div className="numrow" style={{ justifyContent: "center" }}>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            className="btn"
            onClick={() => { window.location.hash = "#/"; window.location.reload(); }}
          >
            Catalogue
          </button>
        </div>
        <p className="note">
          If this appeared straight after an edit, the page may be holding a
          half-swapped module from hot reloading; a full reload clears that.
        </p>
      </div>
    );
  }
}
