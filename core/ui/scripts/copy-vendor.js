#!/usr/bin/env node
/**
 * Copies third-party browser bundles into dist/ so the WebView can load them
 * offline. Runs automatically as `npm run postbuild`.
 *
 * three.js is only fetched by the browser when the Neural Amp 3D view is
 * switched on (core/ui/ts/amp3d loads it with a dynamic import), but the files
 * must still be present next to the built UI.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]scripts$/, '');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const DIST = path.join(ROOT, 'dist');

const FILES = [
  ['jszip/dist/jszip.min.js', 'jszip.min.js'],
  ['alpinejs/dist/cdn.min.js', 'alpine.min.js'],
  // three.js core (three.module.min.js imports three.core.min.js relatively).
  ['three/build/three.module.min.js', 'vendor/three/three.module.min.js'],
  ['three/build/three.core.min.js', 'vendor/three/three.core.min.js'],
  // Addons. Import specifiers are mapped by the import map in index.template.html.
  ['three/examples/jsm/loaders/GLTFLoader.js', 'vendor/three/examples/jsm/loaders/GLTFLoader.js'],
  ['three/examples/jsm/utils/BufferGeometryUtils.js', 'vendor/three/examples/jsm/utils/BufferGeometryUtils.js'],
  ['three/examples/jsm/environments/RoomEnvironment.js', 'vendor/three/examples/jsm/environments/RoomEnvironment.js'],
    // FXAA post chain (EffectComposer pulls MaskPass + CopyShader transitively).
    ['three/examples/jsm/postprocessing/EffectComposer.js', 'vendor/three/examples/jsm/postprocessing/EffectComposer.js'],
    ['three/examples/jsm/postprocessing/Pass.js', 'vendor/three/examples/jsm/postprocessing/Pass.js'],
    ['three/examples/jsm/postprocessing/ShaderPass.js', 'vendor/three/examples/jsm/postprocessing/ShaderPass.js'],
    ['three/examples/jsm/postprocessing/RenderPass.js', 'vendor/three/examples/jsm/postprocessing/RenderPass.js'],
    ['three/examples/jsm/postprocessing/OutputPass.js', 'vendor/three/examples/jsm/postprocessing/OutputPass.js'],
    ['three/examples/jsm/postprocessing/FXAAPass.js', 'vendor/three/examples/jsm/postprocessing/FXAAPass.js'],
    ['three/examples/jsm/postprocessing/MaskPass.js', 'vendor/three/examples/jsm/postprocessing/MaskPass.js'],
    ['three/examples/jsm/shaders/CopyShader.js', 'vendor/three/examples/jsm/shaders/CopyShader.js'],
    ['three/examples/jsm/shaders/FXAAShader.js', 'vendor/three/examples/jsm/shaders/FXAAShader.js'],
    ['three/examples/jsm/shaders/OutputShader.js', 'vendor/three/examples/jsm/shaders/OutputShader.js'],
  ];

let copied = 0;
const missing = [];

for (const [source, target] of FILES) {
  const from = path.join(NODE_MODULES, source);
  const to = path.join(DIST, target);
  if (!fs.existsSync(from)) {
    missing.push(source);
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied += 1;
}

console.log(`[copy-vendor] copied ${copied}/${FILES.length} vendor files into dist/`);

if (missing.length > 0) {
  console.error(`[copy-vendor] missing dependencies (run npm install): ${missing.join(', ')}`);
  process.exitCode = 1;
}
