/**
 * What the viewer is for right now.
 *
 * `simulation` watches what the physics produced; `edit` authors art on top of
 * it. They are separated because the second invalidates the first: an edited
 * surface is no longer the surface the run's temperature, plates and crust ages
 * belong to, and only a recalculation can make them agree again.
 */
export type ViewerMode = "simulation" | "edit";

/**
 * The globe's two tabs.
 *
 * They sit in a strip under the navigation and only while Globe View is
 * selected, because that is what they are tabs OF: the map view is a projection
 * of one recorded step and has neither layers to pick nor a surface to edit.
 *
 * Named for what they show rather than for a state the user is in — "Simulation
 * Layers" and "Topology Editor" say what is behind each tab, which "Simulation"
 * and "Edit" left the reader to guess.
 */
const MODES: readonly { id: ViewerMode; name: string; about: string }[] = [
  {
    id: "simulation", name: "Simulation Layers",
    about: "What the run recorded: every layer it wrote, over any recorded step.",
  },
  {
    id: "edit", name: "Topology Editor",
    about: "Author terrain by hand. Topography only, and the run's other layers "
      + "go stale until a recalculation.",
  },
];

export function ModeSwitch(props: {
  mode: ViewerMode;
  onMode: (m: ViewerMode) => void;
}) {
  return (
    <div className="tabs" role="tablist" aria-label="Globe view">
      {MODES.map(m => (
        <button
          key={m.id}
          className="tab"
          role="tab"
          aria-selected={props.mode === m.id}
          data-on={props.mode === m.id}
          title={m.about}
          onClick={() => props.onMode(m.id)}
        >
          {m.name}
        </button>
      ))}
    </div>
  );
}
