import { useId } from "react";

/**
 * The primitives. Five of them, deliberately.
 *
 * Every control that carries a number shows that number in its own units,
 * because a slider position is not a value. `hint` is where a term gets
 * explained where it appears — the UI carries the same obligation the
 * notebooks do to be followable by someone who is not a specialist.
 */

export function Slider(props: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  /** The value in its units. Shown beside the label, never inferred from the track. */
  display?: string;
  /** Shown under the control. For something the reader must not miss. */
  hint?: string;
  /**
   * Shown on hover instead of under the control.
   *
   * What a control DOES is a description of the control, and a panel of them
   * reads better when each description is one hover away rather than a
   * paragraph pushing the next control off the panel. `hint` stays for the few
   * statements a reader has to see whether they hover or not.
   */
  about?: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="field" title={props.about}>
      <div className="field__label">
        <label className="field__name" htmlFor={id}>{props.label}</label>
        {props.display ? <span className="field__value">{props.display}</span> : null}
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
        aria-label={props.about ? `${props.label} — ${props.about}` : undefined}
        onChange={e => props.onChange(Number(e.currentTarget.value))}
      />
      {props.hint ? <p className="field__hint" id={`${id}-hint`}>{props.hint}</p> : null}
    </div>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  hint?: string;
  action?: React.ReactNode;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <div className="field__label">
        <label className="field__name" htmlFor={id}>{props.label}</label>
        {props.action}
      </div>
      <input
        id={id}
        type="text"
        value={props.value}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
        onChange={e => props.onChange(e.currentTarget.value)}
      />
      {props.hint ? <p className="field__hint" id={`${id}-hint`}>{props.hint}</p> : null}
    </div>
  );
}

/** Label / value pair. `value` is already formatted, with its unit attached. */
export function Row(props: { label: string; value: React.ReactNode }) {
  return (
    <div className="row">
      <span>{props.label}</span>
      <b>{props.value}</b>
    </div>
  );
}

export function Toast(props: { message: string | null }) {
  if (!props.message) return null;
  return <div className="toast" role="status">{props.message}</div>;
}

/** `value` null means the job is queued and has reported no progress yet. */
export function Progress(props: { value: number | null }) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={1}
      {...(props.value === null ? {} : { "aria-valuenow": props.value })}
    >
      <i style={{ width: `${(props.value ?? 0) * 100}%` }} />
    </div>
  );
}
