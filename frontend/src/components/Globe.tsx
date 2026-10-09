import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from "react";
import * as THREE from "three";
// Screen-space thick lines. `LineBasicMaterial.linewidth` is ignored by every
// WebGL browser -- it always draws one pixel -- so a boundary drawn with it is
// invisible at a glance. These build the line as camera-facing quads instead.
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { PLATE_HUES, RAMPS, ramp, type OverlayId, type RampId } from "../lib/colour";
import { INITIAL_PITCH, INITIAL_YAW } from "../lib/view";

/**
 * The globe.
 *
 * React does NOT own the render loop, the geometry buffers, or the
 * camera. It owns a handle. Frames arrive from the WebSocket at ~6 Hz
 * and vertex colours change on every layer toggle; routing either
 * through state would re-render the whole viewer tree for work that
 * ends in a GPU buffer upload.
 *
 * So: props for things that change rarely (which layers are on),
 * imperative methods for things that change often (elevation data).
 */

/**
 * What the globe draws: a surface to displace, one array to colour by, and the
 * range that colour spans.
 *
 * It used to carry a named array per layer — plate, felsic, crustAge,
 * temperatureK — which meant every new layer changed this interface and every
 * frame carried arrays nobody was looking at. A layer that needs one array and a
 * colour range is handed one array and a colour range; choosing WHICH array is
 * the caller's job, and sampling it onto these vertices is `lib/frames.ts`.
 */
export interface CellData {
  /** Metres, one per display vertex. Displaces the surface, whatever is coloured. */
  elevation: Float32Array;
  /** Metres. NaN when the run records no sea level, which is the present case. */
  seaLevel: number;
  /** The active layer's value per display vertex. NaN where nothing was recorded. */
  values: Float32Array;
  /** The colour range in effect. Always shown on screen by the rail. */
  scale: { min: number; max: number };
  /** How a value becomes colour. `category` is a label, never a gradient. */
  kind: "scalar" | "category" | "binary";
  /** Which ramp to use; `null` for categorical layers. */
  ramp: RampId | null;
}

export interface GlobeHandle {
  /** Push new elevations without a React render. */
  setCells(data: CellData): void;
  /** Repaint vertex colours only — no geometry rebuild. */
  repaint(): void;
  /** The run's own cells for this step, or null to draw none. */
  setCloud(sites: { pos: Float32Array; elevation: Float32Array } | null): void;
  /** The step's boundary ticks, already coloured by the physics's labels. */
  setBoundaries(b: { pos: Float32Array; colour: Float32Array; count: number } | null): void;
  /** One arrow per plate, at a fixed scale, or null to draw none. */
  setPlateMotion(a: { pos: Float32Array; count: number } | null): void;
  /** Draw or clear the region outline. Points are unit-sphere xyz. */
  setRegionOutline(points: Float32Array | null): void;
  /** Unit-sphere point under the pointer, or null if the ray misses. */
  hitTest(clientX: number, clientY: number): [number, number, number] | null;
  resize(): void;
}

export interface GlobeProps {
  /** Icosphere vertex positions, xyz triples on the unit sphere. */
  vertices: Float32Array;
  indices: Uint32Array;
  overlays: Record<OverlayId, boolean>;
  /** 0–60, mapped to a radial displacement multiplier. */
  exaggeration: number;
  /**
   * `sun` shades the surface with a fixed lamp; `flat` lights it evenly.
   *
   * Flat is not merely a preference: shading multiplies every colour by a
   * lighting term, so a value near a terminator reads darker than the same
   * value facing the lamp. Flat shows the recorded value and nothing else,
   * which is what a colour scale claims to be showing.
   */
  lighting: "sun" | "flat";
  /** Metres of relief per unit of field elevation, for readouts. */
  reliefM: number;
  /** True while the region tool is armed: suppresses orbit, shows crosshair. */
  regionMode: boolean;
  onPickCell?: (index: number) => void;
  onRegionDragStart?: (p: [number, number, number]) => void;
  onRegionDragMove?: (p: [number, number, number]) => void;
  onRegionDragEnd?: () => void;
  onWebGLUnavailable?: (reason: string) => void;
}

export const Globe = forwardRef<GlobeHandle, GlobeProps>(function Globe(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // Everything mutable lives in one ref object so the render loop can
  // read the latest values without the effect re-running.
  const gl = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    /** The planet. Everything in here turns; the camera and lights do not. */
    world: THREE.Group;
    ambient: THREE.AmbientLight;
    sun: THREE.DirectionalLight;
    rim: THREE.DirectionalLight;
    land: THREE.Mesh;
    water: THREE.Mesh;
    graticule: THREE.Points;
    /** The run's own cells, drawn where they are. */
    cloud: THREE.Points;
    /** Plate boundaries: the interface's own edges, coloured by their labels. */
    bounds: LineSegments2;
    boundsMaterial: LineMaterial;
    /** Which way each plate is sliding. One arrow, three segments, per plate. */
    motion: LineSegments2;
    motionMaterial: LineMaterial;
    cloudSites: { pos: Float32Array; elevation: Float32Array } | null;
    outline: THREE.Line | null;
    raycaster: THREE.Raycaster;
    cells: CellData | null;
    /** How the planet is turned, and how far away the camera sits. */
    yaw: number; pitch: number; radius: number;
    frame: number;
  } | null>(null);

  const propsRef = useRef(props);
  propsRef.current = props;

  // ── setup, once ──────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "WebGL unavailable";
      setFailed(msg);
      propsRef.current.onWebGLUnavailable?.(msg);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);

    // The lamp is fixed and slightly over the viewer's shoulder, because the
    // PLANET turns rather than the camera: the face you are looking at is
    // always the lit one, and relief still reads because the light is off-axis.
    const ambient = new THREE.AmbientLight(0x2a3644, 1.0);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
    sun.position.set(1.6, 1.1, 3.4);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x4a6a8a, 0.6);
    rim.position.set(-2.4, -0.8, 1.2);
    scene.add(rim);
    scene.add(makeStarfield());

    // Everything that belongs to the planet lives in one group, so rotating the
    // planet is one transform and the stars stay put.
    const world = new THREE.Group();
    scene.add(world);

    const { vertices, indices } = propsRef.current;
    const n = vertices.length / 3;

    // Seeded at unit radius in a flat neutral: before a step lands this is
    // the *grid*, not the surface. No elevation is implied and none is
    // drawn — the panels say "not recorded" for every quantity until one is.
    const landGeo = new THREE.BufferGeometry();
    landGeo.setIndex(new THREE.BufferAttribute(indices, 1));
    landGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
    landGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.13), 3));
    const land = new THREE.Mesh(landGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.93, metalness: 0.02,
    }));
    world.add(land);

    const waterGeo = new THREE.BufferGeometry();
    waterGeo.setIndex(new THREE.BufferAttribute(indices, 1));
    waterGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    waterGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const water = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, opacity: 0.86,
      roughness: 0.14, metalness: 0.05, depthWrite: false,
    }));
    world.add(water);

    const graticule = makeGraticule();
    graticule.visible = false;
    world.add(graticule);

    // The simulated cells. Sized once for the largest cloud a run can have and
    // then drawn with a range, so a step that creates or consumes points costs
    // no reallocation -- they change count every iteration.
    const cloudGeo = new THREE.BufferGeometry();
    cloudGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_CLOUD * 3), 3));
    cloudGeo.setDrawRange(0, 0);
    const cloud = new THREE.Points(cloudGeo, new THREE.PointsMaterial({
      color: 0xffd9a0, size: 0.016, sizeAttenuation: true,
      transparent: true, opacity: 0.95, depthTest: true,
    }));
    cloud.visible = false;
    world.add(cloud);

    // The interface: one line per recorded edge, coloured per vertex from the
    // label the physics assigned. Rebuilt when the edges change rather than
    // written into a fixed buffer -- these are quads under the hood, and the
    // count changes every step.
    const boundsMaterial = new LineMaterial({
      vertexColors: true, worldUnits: false, linewidth: BOUNDARY_PX,
      transparent: true, opacity: 0.98, depthTest: true, alphaToCoverage: false,
    });
    const bounds = new LineSegments2(new LineSegmentsGeometry(), boundsMaterial);
    bounds.visible = false;
    world.add(bounds);

    // Plate motion. One flat colour rather than a ramp: the arrow's LENGTH
    // carries the speed, and colouring it by speed as well would say the same
    // thing twice while implying a scale that does not exist.
    const motionMaterial = new LineMaterial({
      color: 0xffe9b0, worldUnits: false, linewidth: 2.4,
      transparent: true, opacity: 0.95, depthTest: true, alphaToCoverage: false,
    });
    const motion = new LineSegments2(new LineSegmentsGeometry(), motionMaterial);
    motion.visible = false;
    world.add(motion);

    const state = {
      renderer, scene, camera, world, land, water, graticule, cloud, bounds,
      boundsMaterial, motion, motionMaterial,
      ambient, sun, rim,
      cloudSites: null as { pos: Float32Array; elevation: Float32Array } | null,
      outline: null as THREE.Line | null,
      raycaster: new THREE.Raycaster(),
      cells: null as CellData | null,
      yaw: INITIAL_YAW, pitch: INITIAL_PITCH, radius: 3.0,
      frame: 0,
    };
    gl.current = state;

    const yAxis = new THREE.Vector3(0, 1, 0);
    const xAxis = new THREE.Vector3(1, 0, 0);
    const qYaw = new THREE.Quaternion();
    const qPitch = new THREE.Quaternion();

    const loop = () => {
      state.frame = requestAnimationFrame(loop);
      // Yaw about the world's pole, then pitch about the screen's horizontal:
      // spin the globe, then tip it. North stays up, which is why the pole is
      // the yaw axis rather than the camera's own vertical.
      qYaw.setFromAxisAngle(yAxis, state.yaw);
      qPitch.setFromAxisAngle(xAxis, state.pitch);
      state.world.quaternion.copy(qPitch).multiply(qYaw);
      camera.position.set(0, 0, state.radius);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(state.frame);
      landGeo.dispose(); waterGeo.dispose(); cloudGeo.dispose();
      bounds.geometry.dispose(); boundsMaterial.dispose();
      motion.geometry.dispose(); motionMaterial.dispose();
      (land.material as THREE.Material).dispose();
      (water.material as THREE.Material).dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      gl.current = null;
    };
    // Mount-only: geometry topology is fixed for a given planet, and the
    // parent remounts via `key` when the planet changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── pointer: orbit, pinch, region drag ───────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    const el = gl.current?.renderer.domElement;
    if (!host || !el) return;

    const pointers = new Map<number, { x: number; y: number }>();
    let orbiting = false;
    let regionDragging = false;
    let last = { x: 0, y: 0 };
    let travelled = 0;
    let pinchStart = 0;
    let radiusStart = 0;

    const spread = () => {
      const [a, b] = [...pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };

    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      travelled = 0;

      if (pointers.size === 2) {
        // Pinch supersedes whatever the first finger was doing.
        orbiting = false;
        regionDragging = false;
        pinchStart = spread();
        radiusStart = gl.current?.radius ?? 3;
        return;
      }
      if (propsRef.current.regionMode) {
        const p = hit(e.clientX, e.clientY);
        if (p) { regionDragging = true; propsRef.current.onRegionDragStart?.(p); }
        return;
      }
      orbiting = true;
      last = { x: e.clientX, y: e.clientY };
    };

    const move = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gl.current;
      if (!g) return;

      if (pointers.size >= 2) {
        const now = spread();
        if (pinchStart > 0 && now > 0) {
          g.radius = clamp(radiusStart * pinchStart / now, 1.35, 9);
        }
        return;
      }
      if (regionDragging) {
        const p = hit(e.clientX, e.clientY);
        if (p) propsRef.current.onRegionDragMove?.(p);
        return;
      }
      if (!orbiting) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      travelled += Math.abs(dx) + Math.abs(dy);
      // The planet follows the pointer, and it is the planet that moves: with
      // the camera on +Z, a positive yaw carries the face toward +X (screen
      // right) and a positive pitch tips it downward. Pitch stops short of the
      // pole, where yaw and pitch would fold into each other.
      g.yaw += dx * 0.005;
      g.pitch = clamp(g.pitch + dy * 0.005, -Math.PI / 2 + 0.08, Math.PI / 2 - 0.08);
      last = { x: e.clientX, y: e.clientY };
    };

    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = 0;
      if (regionDragging) {
        regionDragging = false;
        propsRef.current.onRegionDragEnd?.();
        return;
      }
      if (!orbiting) return;
      orbiting = false;
      // A short press is a tap, not a drag. 4 px of slop covers the
      // jitter a finger produces on a touchscreen.
      if (travelled < 4) pick(e.clientX, e.clientY);
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = gl.current;
      if (g) g.radius = clamp(g.radius * (1 + e.deltaY * 0.0011), 1.35, 9);
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  // ── resize ───────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => doResize());
    ro.observe(host);
    doResize();
    return () => ro.disconnect();
  }, []);

  // Repaint when presentation props change. Cheap: colours only.
  useEffect(() => { paint(); },
    [props.overlays, props.exaggeration]);

  // Lighting. Flat is ambient alone at full strength, so a vertex's colour
  // reaches the screen unmultiplied — the relief goes flat with it, which is
  // the trade the control makes.
  useEffect(() => {
    const g = gl.current;
    if (!g) return;
    const flat = props.lighting === "flat";
    g.ambient.color.set(flat ? 0xffffff : 0x2a3644);
    g.ambient.intensity = flat ? 1.0 : 1.0;
    g.sun.intensity = flat ? 0 : 2.0;
    g.rim.intensity = flat ? 0 : 0.6;
  }, [props.lighting]);

  // ── helpers ──────────────────────────────────────────────────────
  function doResize() {
    const g = gl.current;
    const host = hostRef.current;
    if (!g || !host || !host.clientWidth) return;
    g.camera.aspect = host.clientWidth / host.clientHeight;
    g.camera.updateProjectionMatrix();
    g.renderer.setSize(host.clientWidth, host.clientHeight);
    // Screen-space lines are sized in pixels, so they need to be told how many
    // there are; without this a resize leaves the boundaries the wrong width.
    g.boundsMaterial.resolution.set(
      g.renderer.domElement.width, g.renderer.domElement.height,
    );
  }

  /**
   * Ray/unit-sphere intersection, computed analytically rather than
   * against the displaced mesh. Region coordinates must not shift when
   * the user changes relief exaggeration — that is a display setting,
   * not a change to where anything is.
   */
  function hit(clientX: number, clientY: number): [number, number, number] | null {
    const g = gl.current;
    if (!g) return null;
    const r = g.renderer.domElement.getBoundingClientRect();
    g.raycaster.setFromCamera(new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    ), g.camera);
    const o = g.raycaster.ray.origin;
    const d = g.raycaster.ray.direction;
    const b = 2 * (o.x * d.x + o.y * d.y + o.z * d.z);
    const c = o.x * o.x + o.y * o.y + o.z * o.z - 1;
    const disc = b * b - 4 * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / 2;
    if (t <= 0) return null;
    // The ray hits the sphere in WORLD space, but a region belongs to the
    // planet: the same rock must come back however the globe is turned. Undo
    // the rotation, so the point is in the planet's own frame.
    const world = new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)
      .normalize()
      .applyQuaternion(g.world.quaternion.clone().invert());
    return [world.x, world.y, world.z];
  }

  function pick(clientX: number, clientY: number) {
    const g = gl.current;
    if (!g || !propsRef.current.onPickCell) return;
    const r = g.renderer.domElement.getBoundingClientRect();
    g.raycaster.setFromCamera(new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    ), g.camera);
    const hits = g.raycaster.intersectObject(g.land);
    const face = hits[0]?.face;
    if (face) propsRef.current.onPickCell(face.a);
  }

  function paint() {
    const g = gl.current;
    const cells = g?.cells;
    if (!g || !cells) return;

    const { vertices, overlays, exaggeration } = propsRef.current;
    const n = cells.elevation.length;
    const displace = 1 + (exaggeration / 1000) * 9;
    const sea = cells.seaLevel;
    const hasWater = Number.isFinite(sea);

    const lp = g.land.geometry.attributes.position as THREE.BufferAttribute;
    const lc = g.land.geometry.attributes.color as THREE.BufferAttribute;
    const wp = g.water.geometry.attributes.position as THREE.BufferAttribute;
    const wc = g.water.geometry.attributes.color as THREE.BufferAttribute;
    const P = lp.array as Float32Array;
    const C = lc.array as Float32Array;
    const WP = wp.array as Float32Array;
    const WC = wc.array as Float32Array;

    // One length scale for the whole planet: the largest relief in view. A
    // fixed metre-to-radius factor would flatten a small body and burst a large
    // one, and this one is stated in the rail beside the exaggeration slider.
    const relief = reliefScale(cells);
    const waterRadius = 1 + (sea / relief) * (displace - 1) * 0.11;

    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const x = vertices[j]!, y = vertices[j + 1]!, z = vertices[j + 2]!;
      // Elevation is metres; `relief` normalises it to the sphere's radius so
      // the exaggeration slider means the same thing on any planet.
      const e = cells.elevation[i]!;
      const height = Number.isFinite(e) ? e / relief : 0;
      const r = 1 + height * (displace - 1) * 0.11;
      P[j] = x * r; P[j + 1] = y * r; P[j + 2] = z * r;

      const col = colourFor(i, cells);
      C[j] = col[0]; C[j + 1] = col[1]; C[j + 2] = col[2];

      WP[j] = x * waterRadius; WP[j + 1] = y * waterRadius; WP[j + 2] = z * waterRadius;
      const depth = Math.min(1, Math.max(0, (sea - e) / relief));
      const w = ramp(RAMPS.bathy, 1 - depth);
      WC[j] = w[0]; WC[j + 1] = w[1]; WC[j + 2] = w[2];
    }

    lp.needsUpdate = true; lc.needsUpdate = true;
    wp.needsUpdate = true; wc.needsUpdate = true;
    g.land.geometry.computeVertexNormals();
    g.water.geometry.computeVertexNormals();

    g.water.visible = overlays.water && hasWater;

    // The cells, lifted a hair off the surface they sit on -- same elevation,
    // same exaggeration, same relief scale, so a point never sinks into the
    // ground it belongs to or floats above a neighbouring one.
    const sites = g.cloudSites;
    if (overlays.points && sites) {
      const count = Math.min(sites.pos.length / 3, MAX_CLOUD);
      const attr = g.cloud.geometry.getAttribute("position") as THREE.BufferAttribute;
      const P2 = attr.array as Float32Array;
      for (let i = 0; i < count; i++) {
        const j = i * 3;
        const e = sites.elevation[i]!;
        const h = Number.isFinite(e) ? e / relief : 0;
        const r = 1 + h * (displace - 1) * 0.11 + 0.004;
        P2[j] = sites.pos[j]! * r;
        P2[j + 1] = sites.pos[j + 1]! * r;
        P2[j + 2] = sites.pos[j + 2]! * r;
      }
      attr.needsUpdate = true;
      g.cloud.geometry.setDrawRange(0, count);
    }
    g.cloud.visible = overlays.points && sites !== null;

    // The ticks sit just above the mean surface: a boundary is a line ON the
    // planet, and at true scale it would be buried by any relief either side.
    g.bounds.scale.setScalar(1.006);
    g.bounds.visible = overlays.boundaries && (g.bounds.userData.count ?? 0) > 0;
    // Lifted a little further than the boundaries so an arrow crossing one is
    // not stitched through it.
    g.motion.scale.setScalar(1.012);
    g.motion.visible = overlays.motion && (g.motion.userData.count ?? 0) > 0;
    // A screen-space line needs the viewport to work out how wide a pixel is.
    g.boundsMaterial.resolution.set(
      g.renderer.domElement.width, g.renderer.domElement.height,
    );
    g.graticule.visible = overlays.graticule;
  }

  useImperativeHandle(ref, (): GlobeHandle => ({
    setCells(data) {
      const g = gl.current;
      if (!g) return;
      g.cells = data;
      paint();
    },
    setCloud(sites) {
      const g = gl.current;
      if (!g) return;
      g.cloudSites = sites;
      paint();
    },
    setBoundaries(b) {
      const g = gl.current;
      if (!g) return;
      if (!b || b.count === 0) {
        g.bounds.visible = false;
        g.bounds.userData.count = 0;
        return;
      }
      const count = Math.min(b.count, MAX_BOUNDS);
      const next = new LineSegmentsGeometry();
      next.setPositions(b.pos.subarray(0, count * 6));
      next.setColors(b.colour.subarray(0, count * 6));
      g.bounds.geometry.dispose();
      g.bounds.geometry = next;
      g.bounds.userData.count = count;
      paint();
    },
    setPlateMotion(a) {
      const g = gl.current;
      if (!g) return;
      if (!a || a.count === 0) {
        g.motion.visible = false;
        g.motion.userData.count = 0;
        return;
      }
      const next = new LineSegmentsGeometry();
      next.setPositions(a.pos);
      g.motion.geometry.dispose();
      g.motion.geometry = next;
      g.motion.userData.count = a.count;
      paint();
    },
    repaint: paint,
    setRegionOutline(points) {
      const g = gl.current;
      if (!g) return;
      if (g.outline) {
        g.world.remove(g.outline);
        g.outline.geometry.dispose();
        g.outline = null;
      }
      if (!points) return;
      // Lifted clear of the displaced surface so the outline is not
      // swallowed by a mountain range at high exaggeration.
      const lifted = new Float32Array(points.length);
      for (let i = 0; i < points.length; i++) lifted[i] = points[i]! * 1.035;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(lifted, 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf2a63b }));
      g.world.add(line);
      g.outline = line;
    },
    hitTest: hit,
    resize: doResize,
  }), []);

  if (failed) {
    return (
      <div className="fallback">
        <h2>Nothing to render</h2>
        <p>WebGL is unavailable or switched off in this browser: {failed}</p>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className="viewer__canvas"
      data-picking={props.regionMode}
    />
  );
});

type RGB3 = [number, number, number];

/**
 * The metre range the radial displacement is drawn against.
 *
 * The largest absolute elevation in view, so exaggeration means the same thing
 * on a 3 000 km body and a 24 000 km one. A display transform, and the rail
 * states the number it used.
 */
function reliefScale(c: CellData): number {
  let max = 0;
  for (let i = 0; i < c.elevation.length; i++) {
    const e = Math.abs(c.elevation[i]!);
    if (Number.isFinite(e) && e > max) max = e;
  }
  return max > 0 ? max : 1;
}

function colourFor(i: number, c: CellData): RGB3 {
  const v = c.values[i]!;
  if (!Number.isFinite(v)) return NOT_RECORDED;

  if (c.kind === "category") {
    const h = PLATE_HUES[Math.abs(Math.round(v)) % PLATE_HUES.length]!;
    return [h[0], h[1], h[2]];
  }
  if (c.ramp === null) return NOT_RECORDED;

  // Position in the range the rail is displaying. `ramp` clamps rather than
  // extrapolating, so a value outside a held scale saturates at the end instead
  // of wrapping round to a colour that means something else.
  const span = c.scale.max - c.scale.min;
  const k = span > 0 ? (v - c.scale.min) / span : 0.5;
  const r = ramp(RAMPS[c.ramp], k);
  return [r[0], r[1], r[2]];
}

/**
 * The colour of "the run did not record this here".
 *
 * A distinct, unmistakably non-physical grey: absent must never be drawn as a
 * plausible value at the bottom of the scale.
 */
const NOT_RECORDED: RGB3 = [0.13, 0.14, 0.16];

function makeStarfield(): THREE.Points {
  const pts: number[] = [];
  for (let i = 0; i < 1400; i++) {
    const z = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    const R = 30 + Math.random() * 20;
    pts.push(r * Math.cos(th) * R, r * Math.sin(th) * R, z * R);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x8899aa, size: 0.09, sizeAttenuation: true,
  }));
}

function makeGraticule(): THREE.Points {
  const pts: number[] = [];
  const push = (latDeg: number, lonDeg: number) => {
    const a = (latDeg * Math.PI) / 180;
    const b = (lonDeg * Math.PI) / 180;
    pts.push(Math.cos(a) * Math.cos(b) * 1.002, Math.sin(a) * 1.002, Math.cos(a) * Math.sin(b) * 1.002);
  };
  for (let lat = -60; lat <= 60; lat += 30) for (let lon = 0; lon <= 360; lon += 3) push(lat, lon);
  for (let lon = 0; lon < 360; lon += 30) for (let lat = -87; lat <= 87; lat += 3) push(lat, lon);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({
    color: 0x6f8fa8, size: 0.006, transparent: true, opacity: 0.5,
  }));
}

/** The largest cloud a run may have, from the API's own `maxPoints` ceiling. */
const MAX_CLOUD = 10_000;

/** Boundary edges a step may hold. Roughly the cloud's own ceiling: an edge is
 *  a contact between neighbouring cells, so it scales with them. */
const MAX_BOUNDS = 20_000;

/** How wide a boundary is drawn, in screen pixels. A display choice: the
 *  interface has no width, and at one pixel it could not be seen at all. */
const BOUNDARY_PX = 2.6;

function clamp(x: number, a: number, b: number) { return x < a ? a : x > b ? b : x; }
