/**
 * Where the camera/player currently is, in world space.
 *
 * A single mutable record shared by the streaming systems. Terrain, scatter and
 * weather all read it every few frames; the convoy writes it. Using a plain
 * object rather than React state keeps streaming decisions out of the render
 * cycle entirely.
 */

export const viewer = { x: 0, y: 0, z: 0, heading: 0, speed: 0 };

export const setViewer = (x: number, y: number, z: number, heading: number, speed: number): void => {
  viewer.x = x;
  viewer.y = y;
  viewer.z = z;
  viewer.heading = heading;
  viewer.speed = speed;
};
