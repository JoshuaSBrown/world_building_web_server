/**
 * The one persistent chrome element: brand, where you are, what you can do.
 *
 * Three slots, and the difference matters. `nav` is where you can GO, on the
 * left. `title` is WHAT you are looking at, and it is centred on the bar rather
 * than tucked beside the brand — on the viewer it is the planet's name, which is
 * the heading of the page and reads as one. `children` is what you can DO here,
 * at the far end.
 *
 * None of it is over the page: putting a control on top of the thing it acts on
 * is how a viewer ends up hiding the planet it exists to show.
 */
export function Header(props: {
  /** Centred. The name of the thing on screen. */
  title: string;
  /** A quieter qualifier beside the title — which view of it this is. */
  crumb?: string;
  nav?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="header">
      <span className="brand"><i />Orrery</span>
      <div className="header__nav">{props.nav}</div>
      <div className="header__title">
        <span className="pname pname--bar">{props.title}</span>
        {props.crumb ? <span className="crumb">{props.crumb}</span> : null}
      </div>
      <div className="header__actions">{props.children}</div>
    </header>
  );
}
