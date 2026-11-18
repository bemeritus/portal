/**
 * The realistic mode's ambient occlusion (GTAO). A module of its own so the
 * post-processing code is downloaded only when that mode is first opened on
 * a machine that can afford it.
 */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";

export interface PostFx {
  render(camera: THREE.Camera): void;
  setSize(w: number, h: number): void;
  dispose(): void;
}

export function makePostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  w: number,
  h: number,
): PostFx {
  const fx = new EffectComposer(renderer);
  const pass = new RenderPass(scene, camera);
  const ao = new GTAOPass(scene, camera, w, h);
  ao.updateGtaoMaterial({
    radius: 400,
    distanceExponent: 1,
    thickness: 200,
    scale: 1,
  });
  fx.addPass(pass);
  fx.addPass(ao);
  fx.addPass(new OutputPass());
  fx.setSize(w, h);
  return {
    render(cam) {
      // The camera may have switched between perspective and orthographic.
      pass.camera = cam;
      ao.camera = cam;
      fx.render();
    },
    setSize: (a, b) => fx.setSize(a, b),
    dispose: () => fx.dispose(),
  };
}
