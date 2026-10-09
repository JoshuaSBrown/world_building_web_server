/**
 * Where a planet is looked at from, before anyone drags it.
 *
 * One definition, shared by the globe and the catalogue's thumbnails, so a card
 * shows the hemisphere its planet opens on. Stated as a direction on the sphere
 * rather than a camera position, because that is what both of them need.
 */

/** Longitude of the point facing the viewer, in radians. */
export const INITIAL_THETA = 0.7;
/** Polar angle of that point (0 at the north pole), in radians. */
export const INITIAL_PHI = 1.15;

/**
 * The globe turns; the camera and the lamp do not.
 *
 * The camera used to fly around a fixed planet under a fixed sun, so half the
 * orbit looked at an unlit face — the terminator swept across the view as you
 * dragged. Rotating the planet instead keeps the lit side toward the viewer:
 * the sun sits behind the camera, features turn through the light, and there is
 * no orientation from which the planet is simply dark.
 *
 * These are the same view expressed the other way round: yaw and pitch that
 * bring the direction above to face a camera on +Z.
 */
export const INITIAL_YAW = INITIAL_THETA - Math.PI / 2;
export const INITIAL_PITCH = Math.PI / 2 - INITIAL_PHI;
