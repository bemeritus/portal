/**
 * The floor grid (FEEDBACK-7 §4.1): a shader on one large floor plane, so it
 * has no edge, fading with distance from the camera. Minor lines every
 * 100 mm and major every 1 m, stepping to 1 m / 10 m when zoomed out so the
 * lines' density on screen stays about the same; the major lines stronger.
 * The room's x axis is a thin red line and z a thin blue one through its
 * origin corner, as in Blender. The same grid in 3D and on the plan; none in
 * realistic.
 */

import * as THREE from "three";

const vertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uMinor;
  uniform float uMajor;
  uniform float uMinorAlpha;
  uniform float uMajorAlpha;
  uniform vec3 uCentre;
  uniform float uFade;
  uniform vec3 uAxisX;
  uniform vec3 uAxisZ;
  varying vec3 vWorld;

  // 1 on a line of spacing s, 0 between, one pixel wide at any zoom.
  float lines(vec2 p, float s) {
    vec2 c = p / s;
    vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }
  float line1(float v) {
    return 1.0 - min(abs(v) / fwidth(v), 1.0);
  }

  void main() {
    vec2 p = vWorld.xz;
    float minor = lines(p, uMinor) * uMinorAlpha;
    float major = lines(p, uMajor) * uMajorAlpha;
    float a = max(minor, major);
    float fade = 1.0 - smoothstep(uFade * 0.35, uFade, length(p - uCentre.xz));
    vec3 col = uColor;
    // The axes through the room's origin: x red (along z = 0), z blue.
    float ax = line1(p.y);
    float az = line1(p.x);
    if (ax > 0.01) { col = mix(col, uAxisX, ax); a = max(a, ax * 0.85); }
    if (az > 0.01) { col = mix(col, uAxisZ, az); a = max(a, az * 0.85); }
    a *= fade;
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, a);
  }
`;

export interface GridLook {
  color: string;
  minorAlpha: number;
  majorAlpha: number;
}

export function makeGrid(look: GridLook): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(400000, 400000);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(look.color) },
      uMinor: { value: 100 },
      uMajor: { value: 1000 },
      uMinorAlpha: { value: look.minorAlpha },
      uMajorAlpha: { value: look.majorAlpha },
      uCentre: { value: new THREE.Vector3() },
      uFade: { value: 20000 },
      uAxisX: { value: new THREE.Color("#d9483b") },
      uAxisZ: { value: new THREE.Color("#3b74d9") },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 1;
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.userData.grid = true;
  return mesh;
}

/**
 * Follow the camera: spacing by the size of a millimetre on screen (minor
 * lines no closer than 8 px), the fade around what the camera looks at.
 */
export function updateGrid(
  grid: THREE.Mesh,
  cam: THREE.Camera,
  target: THREE.Vector3,
  heightPx: number,
) {
  const u = (grid.material as THREE.ShaderMaterial).uniforms;
  let mmPerPx: number;
  if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
    const o = cam as THREE.OrthographicCamera;
    mmPerPx = (o.top - o.bottom) / o.zoom / heightPx;
  } else {
    const p = cam as THREE.PerspectiveCamera;
    mmPerPx =
      (2 *
        cam.position.distanceTo(target) *
        Math.tan((p.fov * Math.PI) / 360)) /
      heightPx;
  }
  const coarse = 100 / mmPerPx < 8;
  u.uMinor.value = coarse ? 1000 : 100;
  u.uMajor.value = coarse ? 10000 : 1000;
  u.uCentre.value.copy(target);
  u.uFade.value = Math.max(8000, mmPerPx * heightPx * 2.2);
}
