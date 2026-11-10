// Målningen i The Character Creator (docs/asset-studio.md): Patrik målar hudens färg direkt på figuren, på MPFB:s
// gemensamma UV, oftast från referensbilder. Penseln arbetar i UV-rummet: varje texel räknar ut var den syns i vyn
// (skärmläget, djupet mot en djupkarta från samma kamera och hur mycket ytan vänder sig mot kameran), och den som ligger
// under penseln får färg. Källorna är en färg, referensbilden (en bild över vyn som kan flyttas, skalas och vridas, som
// Blenders stencil), Blur och Erase (tillbaka till grunden). Spegling i x målar båda sidorna (kroppen är symmetrisk).
// Project the picture lägger hela bilden på det som syns. Save skriver en ny <namn>_paint_v<n>_color.png (aldrig över),
// med påfyllning runt UV-öarna, och Finished model hittar den som färgkarta. Texten i appen är på engelska.
import * as THREE from 'three';

const N = 2048; // texturens sida (MPFB:s UV, som bakningarna)
// Hex till rått sRGB 0..1 (THREE.Color räknar om till linjärt, men målet håller sRGB-värdena som de är)
const srgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

const VERT_UV = /* glsl */`
varying vec3 vP; varying vec3 vN; varying vec2 vUv;
void main() { vP = position; vN = normal; vUv = uv; gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`;
const FRAG_DAB = /* glsl */`
uniform mat4 uVP, uV; uniform vec2 uRes, uBrush, uTexel, uPicC, uPicS;
uniform float uRadius, uHard, uStrength, uFace, uCx, uPicR;
uniform bool uMirror, uAll, uPicFlip;
uniform int uMode; uniform vec3 uColor, uCam;
uniform sampler2D uDepth, uPic, uBase, uCopy;
varying vec3 vP; varying vec3 vN; varying vec2 vUv;
float weight(vec3 q, vec3 n, out vec2 scr) {
  scr = vec2(-1e6);
  vec4 c = uVP * vec4(q, 1.0);
  if (c.w <= 0.0) return 0.0;
  vec3 nd = c.xyz / c.w;
  if (abs(nd.x) > 1.0 || abs(nd.y) > 1.0) return 0.0;
  scr = (nd.xy * 0.5 + 0.5) * uRes;
  float vz = -(uV * vec4(q, 1.0)).z;
  float d = texture2D(uDepth, nd.xy * 0.5 + 0.5).r;
  if (vz > d + 0.006 * (1.0 + vz)) return 0.0;         // skymd
  float f = dot(normalize(n), normalize(uCam - q));
  float fade = smoothstep(uFace, min(1.0, uFace + 0.25), f);
  float r = uAll ? 0.0 : length(scr - uBrush) / uRadius;
  if (r > 1.0) return 0.0;
  return (1.0 - smoothstep(uHard, 1.0, r)) * fade;
}
vec4 pic(vec2 scr) {
  vec2 css = vec2(scr.x, uRes.y - scr.y) - uPicC;
  float s = sin(-uPicR), co = cos(-uPicR);
  vec2 uv = vec2(co * css.x - s * css.y, s * css.x + co * css.y) / uPicS + 0.5;
  if (uPicFlip) uv.x = 1.0 - uv.x;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uPic, uv);
}
void main() {
  vec2 s1, s2;
  float w1 = weight(vP, vN, s1), w2 = 0.0;
  if (uMirror) w2 = weight(vec3(2.0 * uCx - vP.x, vP.y, vP.z), vec3(-vN.x, vN.y, vN.z), s2);
  vec3 col; float w;
  if (uMode == 1) {
    vec4 a = w1 > 0.0 ? pic(s1) : vec4(0.0), b = w2 > 0.0 ? pic(s2) : vec4(0.0);
    float wa = w1 * a.a, wb = w2 * b.a;
    if (wa >= wb) { col = a.rgb; w = wa; } else { col = b.rgb; w = wb; }
  } else {
    w = max(w1, w2);
    if (uMode == 0) col = uColor;
    else if (uMode == 2) col = texture2D(uBase, vUv).rgb;
    else {
      col = vec3(0.0);
      for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) col += texture2D(uCopy, vUv + vec2(float(i), float(j)) * uTexel * 1.5).rgb;
      col /= 25.0;
    }
  }
  if (w <= 0.001) discard;
  gl_FragColor = vec4(col, clamp(w * uStrength, 0.0, 1.0));
}`;

export function createPainter({ el, api, side, view, renderer, controls, getCam, getFigure, draw, say }) {
  let active = false, name = null, fig = null, body = null, dirty = false;
  const P = { tool: 'color', color: '#b98a72', radius: 40, strength: 0.6, hard: 0.5, face: 0.15, mirror: true, lit: true,
    opacity: 0.55, size: 1, rot: 0, flip: false, base: null, skin: '#c9a48c' };
  const rtOpt = { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, depthBuffer: false };
  const rt = new THREE.WebGLRenderTarget(N, N, rtOpt), copyRt = new THREE.WebGLRenderTarget(N, N, rtOpt), maskRt = new THREE.WebGLRenderTarget(N, N, rtOpt);
  const depthRt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const undo = [], redo = [], spare = [];
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;

  // --- Penselns material, kopiering och djupet ---
  const dabMat = new THREE.ShaderMaterial({
    vertexShader: VERT_UV, fragmentShader: FRAG_DAB, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    uniforms: {
      uVP: { value: new THREE.Matrix4() }, uV: { value: new THREE.Matrix4() }, uRes: { value: new THREE.Vector2(1, 1) }, uBrush: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2(1 / N, 1 / N) }, uPicC: { value: new THREE.Vector2() }, uPicS: { value: new THREE.Vector2(1, 1) },
      uRadius: { value: 40 }, uHard: { value: 0.5 }, uStrength: { value: 1 }, uFace: { value: 0.15 }, uCx: { value: 0 }, uPicR: { value: 0 },
      uMirror: { value: true }, uAll: { value: false }, uPicFlip: { value: false }, uMode: { value: 0 }, uColor: { value: new THREE.Vector3(1, 1, 1) },
      uCam: { value: new THREE.Vector3() }, uDepth: { value: null }, uPic: { value: white }, uBase: { value: white }, uCopy: { value: copyRt.texture },
    },
  });
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const copyMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: null } }, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D uTex; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(uTex, vUv).rgb, 1.0); }',
  });
  const quad = new THREE.Mesh(quadGeo, copyMat); quad.frustumCulled = false;
  const quadScene = new THREE.Scene(); quadScene.add(quad);
  const maskMat = new THREE.ShaderMaterial({ vertexShader: VERT_UV, fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }', side: THREE.DoubleSide, depthTest: false });
  const depthMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: 'varying float vZ; void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'varying float vZ; void main() { gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }',
  });
  const uvScene = new THREE.Scene(), depthScene = new THREE.Scene(), flatCam = new THREE.Camera();
  let geo = null, lineGeo = null, pick = null;

  // Visningen: figurens kropp med den målade texturen (rått sRGB i målet, avkodas här)
  const decode = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#ifdef USE_MAP
      vec4 sampledDiffuseColor = texture2D( map, vMapUv );
      vec3 cs = sampledDiffuseColor.rgb;
      sampledDiffuseColor.rgb = mix(cs / 12.92, pow((cs + 0.055) / 1.055, vec3(2.4)), step(0.04045, cs));
      diffuseColor *= sampledDiffuseColor;
    #endif`);
  };
  const litMat = new THREE.MeshStandardMaterial({ map: rt.texture, roughness: 0.55, side: THREE.DoubleSide });
  litMat.onBeforeCompile = decode;
  const flatMat = new THREE.MeshBasicMaterial({ map: rt.texture, side: THREE.DoubleSide });
  flatMat.onBeforeCompile = decode; flatMat.toneMapped = false;

  function blit(src, dst) {
    copyMat.uniforms.uTex.value = src;
    renderer.setRenderTarget(dst); renderer.render(quadScene, flatCam); renderer.setRenderTarget(null);
  }

  // --- Figuren: kroppens hörn i världen (skinnade nät räknas om), UV och normaler, för penseln och djupet ---
  function buildGeometry(mesh) {
    mesh.updateMatrixWorld(true);
    const g = mesh.geometry, n = g.attributes.position.count, pos = new Float32Array(n * 3), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); pos.set([v.x, v.y, v.z], 3 * i); }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('uv', g.attributes.uv);
    if (g.index) out.setIndex(g.index);
    out.computeVertexNormals();
    out.computeBoundingSphere(); out.computeBoundingBox();
    // Kanterna som linjer: texlarna längs UV-öarnas kanter får färg också (trianglarna täcker dem inte alltid)
    const idx = g.index ? g.index.array : Array.from({ length: n }, (_, i) => i), lines = new Uint32Array(idx.length * 2);
    for (let t = 0; t < idx.length; t += 3) lines.set([idx[t], idx[t + 1], idx[t + 1], idx[t + 2], idx[t + 2], idx[t]], t * 2);
    const lg = new THREE.BufferGeometry();
    for (const k of ['position', 'uv', 'normal']) lg.setAttribute(k, out.attributes[k]);
    lg.setIndex(new THREE.BufferAttribute(lines, 1));
    return [out, lg];
  }
  function setScenes() {
    uvScene.clear(); depthScene.clear();
    const m = new THREE.Mesh(geo, dabMat), l = new THREE.LineSegments(lineGeo, dabMat);
    m.frustumCulled = l.frustumCulled = false;
    uvScene.add(m, l);
    const d = new THREE.Mesh(geo, depthMat); d.frustumCulled = false;
    depthScene.add(d);
    pick = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const bb = geo.boundingBox;
    dabMat.uniforms.uCx.value = (bb.min.x + bb.max.x) / 2;
  }
  function renderMask() {
    const ms = new THREE.Scene(), m = new THREE.Mesh(geo, maskMat), l = new THREE.LineSegments(lineGeo, maskMat);
    m.frustumCulled = l.frustumCulled = false; ms.add(m, l);
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setRenderTarget(maskRt); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(ms, flatCam);
    renderer.setRenderTarget(null); renderer.setClearColor(cc, ca);
  }

  // --- Grunden: en färgkarta (MPFB:s UV) eller en jämn hudfärg ---
  const texLoader = new THREE.TextureLoader();
  async function setBase(file) {
    P.base = file || null;
    let tex = white;
    if (file) {
      tex = await texLoader.loadAsync(`/${file}?v=${Date.now()}`).catch(() => null);
      if (!tex) { say(`Could not load ${file}`); tex = white; P.base = null; }
      else { tex.flipY = false; tex.colorSpace = THREE.NoColorSpace; tex.needsUpdate = true; }
    }
    if (tex === white) {
      const d = new Uint8Array([...srgb(P.skin).map((x) => Math.round(x * 255)), 255]);
      tex = new THREE.DataTexture(d, 1, 1); tex.needsUpdate = true;
    }
    if (dabMat.uniforms.uBase.value !== white) dabMat.uniforms.uBase.value.dispose?.();
    dabMat.uniforms.uBase.value = tex;
    blit(tex, rt);
  }

  // --- Referensbilden över vyn ---
  const picEl = el('img', 'hu-pic');
  picEl.hidden = true; picEl.draggable = false;
  view.append(picEl);
  const ringEl = el('div', 'hu-brush');
  ringEl.hidden = true;
  view.append(ringEl);
  let pic = null; // { url, tex, w, h, cx, cy, canvas }
  async function setPic(url) {
    if (!url) { pic = null; picEl.hidden = true; dabMat.uniforms.uPic.value = white; renderPicList(); return; }
    const img = new Image();
    img.src = url;
    await img.decode();
    const tex = new THREE.Texture(img);
    tex.flipY = false; tex.colorSpace = THREE.NoColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    pic?.tex.dispose();
    const cv = document.createElement('canvas');
    cv.width = Math.min(1024, img.naturalWidth); cv.height = Math.round(cv.width * img.naturalHeight / img.naturalWidth);
    cv.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, cv.width, cv.height);
    pic = { url, tex, aspect: img.naturalWidth / img.naturalHeight, canvas: cv };
    picEl.src = url;
    dabMat.uniforms.uPic.value = tex;
    // En genererad vy minns kameran och rutan den ritades för: vyn ställs tillbaka och bilden läggs exakt där
    const meta = /\/view_\d+\.png$/.test(url) ? await fetch(url.replace(/\.png$/, '.json')).then((x) => (x.ok ? x.json() : null)).catch(() => null) : null;
    if (meta?.camera && meta?.rect) {
      const cam = getCam();
      cam.position.fromArray(meta.camera.position); controls.target.fromArray(meta.camera.target);
      if (meta.camera.fov && cam.isPerspectiveCamera) { cam.fov = meta.camera.fov; cam.updateProjectionMatrix(); }
      cam.lookAt(controls.target); controls.update();
      placeAt(meta.rect);
    } else fitPic();
    renderPicList();
  }
  // Bilden lika hög som figuren på skärmen, mitt över den
  function fitPic() {
    if (!pic) return;
    const cam = getCam(), bb = geo.boundingBox, r = view.getBoundingClientRect();
    const top = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.max.y, (bb.min.z + bb.max.z) / 2).project(cam);
    const bot = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2).project(cam);
    const y0 = (1 - top.y) / 2 * r.height, y1 = (1 - bot.y) / 2 * r.height, x = (top.x + 1) / 2 * r.width;
    const h = Math.max(40, y1 - y0) * 1.04;
    Object.assign(pic, { cx: x, cy: (y0 + y1) / 2, h0: h });
    P.size = 1; P.rot = 0;
    placePic(); cardsSync();
  }
  function placePic() {
    if (!pic) { picEl.hidden = true; return; }
    const h = pic.h0 * P.size, w = h * pic.aspect;
    Object.assign(pic, { w, h });
    picEl.hidden = !active;
    Object.assign(picEl.style, { left: `${pic.cx - w / 2}px`, top: `${pic.cy - h / 2}px`, width: `${w}px`, height: `${h}px`, opacity: P.opacity,
      transform: `rotate(${P.rot}deg)${P.flip ? ' scaleX(-1)' : ''}` });
  }
  // En bild som lagts på en bestämd ruta i vyn (en genererad vy): rutan sparas i förhållande till vyns höjd
  function placeAt(rect) {
    const r = view.getBoundingClientRect();
    Object.assign(pic, { cx: r.width / 2 + rect.nx * r.height, cy: r.height / 2 + rect.ny * r.height, h0: rect.nh * r.height });
    P.size = 1; P.rot = 0; P.flip = false;
    placePic(); cardsSync();
  }
  // Färgen i bilden under en punkt i vyn (CSS-pixlar), eller null utanför
  function picColor(x, y) {
    if (!pic) return null;
    const a = -P.rot * Math.PI / 180, dx = x - pic.cx, dy = y - pic.cy;
    let u = (Math.cos(a) * dx - Math.sin(a) * dy) / pic.w + 0.5;
    const v = (Math.sin(a) * dx + Math.cos(a) * dy) / pic.h + 0.5;
    if (P.flip) u = 1 - u;
    if (u < 0 || v < 0 || u > 1 || v > 1) return null;
    const d = pic.canvas.getContext('2d').getImageData(Math.min(pic.canvas.width - 1, Math.floor(u * pic.canvas.width)), Math.min(pic.canvas.height - 1, Math.floor(v * pic.canvas.height)), 1, 1).data;
    return d[3] > 10 ? `#${[d[0], d[1], d[2]].map((c) => c.toString(16).padStart(2, '0')).join('')}` : null;
  }

  // --- Penseln ---
  function prepare() {
    const cam = getCam(), r = view.getBoundingClientRect();
    cam.updateMatrixWorld(); cam.updateProjectionMatrix?.();
    const W = Math.max(4, Math.round(r.width)), H = Math.max(4, Math.round(r.height));
    if (depthRt.width !== W || depthRt.height !== H) depthRt.setSize(W, H);
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setRenderTarget(depthRt); renderer.setClearColor(new THREE.Color(1e5, 0, 0), 1); renderer.clear();
    renderer.render(depthScene, cam);
    renderer.setRenderTarget(null); renderer.setClearColor(cc, ca);
    const u = dabMat.uniforms;
    u.uVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    u.uV.value.copy(cam.matrixWorldInverse);
    u.uCam.value.setFromMatrixPosition(cam.matrixWorld);
    u.uRes.value.set(r.width, r.height);
    u.uDepth.value = depthRt.texture;
    u.uMode.value = { color: 0, picture: 1, erase: 2, blur: 3 }[P.tool];
    u.uColor.value.set(...srgb(P.color)); // rått sRGB, som målet
    Object.assign(u.uRadius, { value: P.radius }); u.uHard.value = P.hard; u.uFace.value = P.face; u.uMirror.value = P.mirror;
    if (pic) { u.uPicC.value.set(pic.cx, pic.cy); u.uPicS.value.set(pic.w, pic.h); u.uPicR.value = P.rot * Math.PI / 180; u.uPicFlip.value = P.flip; }
    return r;
  }
  function dab(x, y, pressure = 1, all = false) {
    const u = dabMat.uniforms, r = view.getBoundingClientRect();
    if (P.tool === 'blur') blit(rt.texture, copyRt);
    u.uBrush.value.set(x, r.height - y);
    u.uAll.value = all;
    u.uStrength.value = P.strength * pressure;
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt); renderer.render(uvScene, flatCam); renderer.setRenderTarget(null);
    renderer.autoClear = ac;
    dirty = true;
  }
  function snapshot() {
    const s = spare.pop() ?? (undo.length >= 12 ? undo.shift() : new THREE.WebGLRenderTarget(N, N, rtOpt));
    blit(rt.texture, s); undo.push(s);
    for (const x of redo.splice(0)) spare.push(x);
    updateInfo();
  }
  function step(from, to) {
    const s = from.pop();
    if (!s) return;
    const t = spare.pop() ?? new THREE.WebGLRenderTarget(N, N, rtOpt);
    blit(rt.texture, t); to.push(t);
    blit(s.texture, rt); spare.push(s);
    dirty = true; updateInfo();
  }

  // --- Pekaren: vänster målar, mitten eller Alt vrider, höger flyttar vyn; Shift flyttar bilden, Ctrl tar en färg ---
  const dom = renderer.domElement;
  let stroke = null, picDrag = null;
  const local = (e) => { const r = view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const hit = (x, y) => {
    const r = view.getBoundingClientRect(), rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(x / r.width * 2 - 1, -(y / r.height) * 2 + 1), getCam());
    return rc.intersectObject(pick)[0] ?? null;
  };
  function eyedrop(x, y) {
    let c = pic && !picEl.hidden ? picColor(x, y) : null;
    if (!c) {
      const h = hit(x, y);
      if (!h?.uv) return;
      const px = new Uint8Array(4);
      renderer.readRenderTargetPixels(rt, Math.min(N - 1, Math.floor(h.uv.x * N)), Math.min(N - 1, Math.floor(h.uv.y * N)), 1, 1, px);
      c = `#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
    P.color = c; P.tool = 'color'; cardsSync();
    say(`Picked ${c}`);
  }
  const stop = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };
  dom.addEventListener('pointerdown', (e) => {
    if (!active) return;
    const [x, y] = local(e);
    if (e.button === 0 && e.shiftKey && pic) { picDrag = { x, y, cx: pic.cx, cy: pic.cy, rot: P.rot, rotate: e.ctrlKey }; dom.setPointerCapture(e.pointerId); stop(e); return; }
    if (e.button !== 0 || e.altKey) return;
    if (e.ctrlKey || e.metaKey) { eyedrop(x, y); stop(e); return; }
    snapshot(); prepare();
    stroke = { x, y };
    dab(x, y, e.pointerType === 'pen' ? e.pressure || 0.5 : 1);
    dom.setPointerCapture(e.pointerId);
    stop(e);
  }, true);
  dom.addEventListener('pointermove', (e) => {
    if (!active) return;
    const [x, y] = local(e);
    Object.assign(ringEl.style, { left: `${x - P.radius}px`, top: `${y - P.radius}px`, width: `${2 * P.radius}px`, height: `${2 * P.radius}px` });
    ringEl.hidden = false;
    if (picDrag) {
      if (picDrag.rotate) P.rot = picDrag.rot + (x - picDrag.x) * 0.3;
      else { pic.cx = picDrag.cx + x - picDrag.x; pic.cy = picDrag.cy + y - picDrag.y; }
      placePic(); cardsSync(); return;
    }
    if (!stroke) return;
    const d = Math.hypot(x - stroke.x, y - stroke.y), gap = Math.max(1.5, P.radius * 0.2);
    if (d < gap) return;
    const pr = e.pointerType === 'pen' ? e.pressure || 0.5 : 1;
    for (let k = 1, n = Math.floor(d / gap); k <= n; k++) dab(stroke.x + (x - stroke.x) * k / n, stroke.y + (y - stroke.y) * k / n, pr);
    stroke = { x, y };
  }, true);
  const end = () => { if (stroke || picDrag) { stroke = null; picDrag = null; updateInfo(); } };
  addEventListener('pointerup', end);
  dom.addEventListener('pointerleave', () => { ringEl.hidden = true; });
  dom.addEventListener('wheel', (e) => {
    if (!active || !e.shiftKey || !pic) return;
    P.size = Math.min(6, Math.max(0.1, P.size * (e.deltaY > 0 ? 1 / 1.06 : 1.06)));
    placePic(); cardsSync(); stop(e);
  }, { capture: true, passive: false });
  addEventListener('keydown', (e) => {
    if (!active || e.target.closest?.('input, select, textarea')) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? step(redo, undo) : step(undo, redo); }
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); step(redo, undo); }
    else if (k === '[') { P.radius = Math.max(3, P.radius / 1.2); cardsSync(); }
    else if (k === ']') { P.radius = Math.min(400, P.radius * 1.2); cardsSync(); }
    else if (k.toLowerCase() === 'h' && pic) { picEl.hidden = !picEl.hidden; }
  });
  // Bilder som släpps i vyn eller klistras in blir referenser
  view.addEventListener('dragover', (e) => { if (active) e.preventDefault(); });
  view.addEventListener('drop', (e) => { if (!active) return; e.preventDefault(); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) addRef(f); });
  addEventListener('paste', (e) => { if (!active) return; const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/')); if (f) addRef(f); });

  // --- Kortet ---
  const card = el('section', 'card glass hu-paint');
  card.style.setProperty('--part', '#d1873a');
  const head = el('header'); head.append(el('h2', null, 'Paint the skin'));
  const rows = el('div', 'rows');
  card.append(head, rows);
  const syncs = [];
  const cardsSync = () => { for (const s of syncs) s(); placePic(); };
  function slider(label, key, min, max, stepv, help, after) {
    const row = el('div', 'row'), r = el('input'), out = el('output');
    row.title = help;
    Object.assign(r, { type: 'range', min, max, step: stepv });
    const dec = stepv >= 1 ? 0 : 2;
    syncs.push(() => { r.value = P[key]; out.textContent = Number(P[key]).toFixed(dec); });
    r.oninput = () => { P[key] = Number(r.value); out.textContent = P[key].toFixed(dec); after?.(); };
    row.append(el('label', null, label), r, out);
    return row;
  }
  function toggle(label, sub, key, help, after) {
    const row = el('div', 'row span2'), box = el('input', 'switch'), lab = el('label', 'twoline');
    box.type = 'checkbox'; row.title = help;
    lab.append(document.createTextNode(label), el('small', null, sub));
    syncs.push(() => { box.checked = !!P[key]; });
    box.onchange = () => { P[key] = box.checked; after?.(box.checked); };
    row.append(lab, box);
    return row;
  }
  function seg(label, opts, key, after) {
    const row = el('div', 'row span2 hu-seg4'), s = el('div', 'seg');
    for (const [id, text, help] of opts) {
      const b = el('button', null, text);
      b.title = help; b.dataset.id = id;
      b.onclick = () => { P[key] = id; cardsSync(); after?.(id); };
      s.append(b);
    }
    syncs.push(() => { for (const b of s.children) b.classList.toggle('on', b.dataset.id === P[key]); });
    row.append(el('label', null, label), s);
    return row;
  }
  function colorRow(label, key, help) {
    const row = el('div', 'row span2'), c = el('input');
    c.type = 'color'; row.title = help;
    syncs.push(() => { c.value = P[key]; });
    c.oninput = () => { P[key] = c.value; if (key === 'color') { P.tool = 'color'; cardsSync(); } };
    row.append(el('label', null, label), c);
    return row;
  }
  const baseSel = el('select');
  const baseRow = el('div', 'row span2');
  baseRow.title = 'What the painting starts from: a colour map on MPFB\'s UV (a bake, or an earlier painting), or one even skin colour. Changing it starts over';
  baseRow.append(el('label', null, 'Start from'), baseSel);
  baseSel.onchange = async () => {
    if (dirty && !confirm('Start over from the new base and drop the painting?')) { baseSel.value = P.base ?? ''; return; }
    snapshot(); await setBase(baseSel.value); dirty = false; updateInfo();
  };
  const skinRow = colorRow('Skin colour', 'skin', 'The even skin colour to start from, when there is no colour map');
  skinRow.querySelector('input').addEventListener('change', async () => { if (!P.base && !dirty) { await setBase(null); } });

  const picList = el('div', 'hu-pics');
  const picFile = Object.assign(el('input'), { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  picFile.onchange = () => { if (picFile.files[0]) addRef(picFile.files[0]); picFile.value = ''; };
  let refs = [];
  function renderPicList() {
    picList.replaceChildren(...refs.map((u) => {
      const b = el('button', `hu-picbtn${pic?.url === u ? ' on' : ''}`);
      b.title = u.split('/').pop();
      b.append(Object.assign(el('img'), { src: u, alt: '' }));
      b.onclick = async () => { await setPic(pic?.url === u ? null : u); if (pic) { P.tool = 'picture'; cardsSync(); } };
      return b;
    }), (() => { const b = el('button', 'hu-picbtn add', '+'); b.title = 'Add a reference picture (or drop one on the view, or paste it)'; b.onclick = () => picFile.click(); return b; })(), picFile);
  }
  async function addRef(file) {
    say(`Uploading ${file.name}…`);
    const r = await fetch(`/api/human/ref?name=${encodeURIComponent(name)}&file=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    if (r.error) { say(`Not added: ${r.error}`); return; }
    refs.push(r.url);
    await setPic(r.url);
    P.tool = 'picture'; cardsSync();
    say(`Added ${r.url.split('/').pop()}: Shift+drag moves it, Shift+wheel scales it`);
  }
  const viewRow = el('div', 'row span2 hu-seg4'), vseg = el('div', 'seg');
  viewRow.title = 'Turn the figure to a straight view, to project a front or side picture';
  for (const [id, text, dir] of [['front', 'Front', [0, 0, 1]], ['left', 'Left', [1, 0, 0]], ['back', 'Back', [0, 0, -1]], ['right', 'Right', [-1, 0, 0]]]) {
    const b = el('button', null, text);
    b.onclick = () => {
      const bb = geo.boundingBox, h = bb.max.y - bb.min.y, t = new THREE.Vector3(dabMat.uniforms.uCx.value, bb.min.y + h * 0.5, (bb.min.z + bb.max.z) / 2);
      const cam = getCam();
      controls.target.copy(t);
      cam.position.copy(t).addScaledVector(new THREE.Vector3(...dir), h / (2 * Math.tan((cam.fov ?? 30) * Math.PI / 360)) * 1.15);
      cam.lookAt(t); controls.update();
      if (pic) requestAnimationFrame(fitPic);
    };
    vseg.append(b);
  }
  viewRow.append(el('label', null, 'View'), vseg);
  const projBtn = el('button', null, 'Project the picture');
  projBtn.title = 'Lays the whole reference picture on every part of the figure that faces you (mirrored too when Mirror is on)';
  projBtn.onclick = () => { if (!pic) { say('Add or pick a reference picture first'); return; } const t = P.tool; P.tool = 'picture'; snapshot(); prepare(); dab(0, 0, 1, true); P.tool = t; updateInfo(); say('Projected the picture'); };
  const fitBtn = el('button', null, 'Fit to figure');
  fitBtn.title = 'Scales the picture to the figure\'s height on screen and centres it over it';
  fitBtn.onclick = fitPic;
  const picBtns = el('div', 'hu-btns'); picBtns.append(fitBtn, projBtn);
  // --- En ny referensbild för vinkeln i vyn (gpt-image-2 via OpenRouter, kostar pengar: priset visas och frågas först) ---
  const PROMPT = 'The first image is a plain 3D render of a character from one camera angle. Repaint it as a finished, painted colour reference of the same person shown in the other images: the same skin tone, face, markings and colours, in the same painted style. Keep the render\'s exact pose, silhouette, proportions, camera angle and framing, so the picture lines up with the render pixel for pixel. Plain light grey background, even soft light, no strong shadows. No hair over the face, no jewellery, and no clothes that are not in the reference pictures.';
  const promptEl = Object.assign(el('textarea', 'hu-prompt'), { rows: 4, value: PROMPT });
  promptEl.title = 'What the picture model is asked for (the render comes first, then the reference pictures)';
  const genBtn = el('button', 'primary', 'Generate this view…');
  genBtn.title = 'Renders the figure as you see it now and asks gpt-image-2 for a reference picture of this angle in the style of the reference pictures; it lands over the view, lined up, and is kept with the figure. Costs money: the price is shown first';
  const genMsg = el('div', 'note');
  // Figurens del av vyn: en ruta runt kroppen (2:3, 1:1 eller 3:2), som bild och som läge i vyn
  function viewShot() {
    const cam = getCam(), r = view.getBoundingClientRect(), p = geo.attributes.position, v = new THREE.Vector3();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.count; i += 7) {
      v.fromBufferAttribute(p, i).project(cam);
      const x = (v.x + 1) / 2 * r.width, y = (1 - v.y) / 2 * r.height;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    let w = (x1 - x0) * 1.08, h = (y1 - y0) * 1.08;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const [aspect, a] = [['2:3', 2 / 3], ['1:1', 1], ['3:2', 3 / 2]].reduce((b, c) => (Math.abs(Math.log(w / h / c[1])) < Math.abs(Math.log(w / h / b[1])) ? c : b));
    if (w / h < a) w = h * a; else h = w / a;
    draw();
    const src = renderer.domElement, k = src.width / r.width, out = document.createElement('canvas');
    const W = a >= 1 ? 1024 : Math.round(1024 * a), H = a >= 1 ? Math.round(1024 / a) : 1024;
    out.width = W; out.height = H;
    const g = out.getContext('2d');
    g.fillStyle = '#c8ccd0'; g.fillRect(0, 0, W, H);
    g.drawImage(src, (cx - w / 2) * k, (cy - h / 2) * k, w * k, h * k, 0, 0, W, H);
    return { aspect, png: out.toDataURL('image/png'), rect: { nx: (cx - r.width / 2) / r.height, ny: (cy - r.height / 2) / r.height, nh: h / r.height }, size: [W, H],
      camera: { position: cam.position.toArray(), target: controls.target.toArray(), fov: cam.fov ?? null } };
  }
  // Referenserna som följer med: Patriks egna först, sedan genererade vyer, högst fyra
  const genRefs = () => [...refs.filter((u) => !/\/view_\d+\.png$/.test(u)), ...refs.filter((u) => /\/view_\d+\.png$/.test(u))].slice(0, 4);
  let genJob = null;
  genBtn.onclick = async () => {
    const shot = viewShot(), list = genRefs();
    if (!list.length && !confirm('There are no reference pictures yet, so the model only sees the render. Go on?')) return;
    const req = { name, render: shot.png, refs: list, prompt: promptEl.value, aspect: shot.aspect, camera: shot.camera, rect: shot.rect };
    const q = await api('/api/human/genview', req);
    if (q.error) { genMsg.textContent = `Not started: ${q.error}`; return; }
    if (!confirm(`Generate a ${shot.aspect} reference picture of this view with ${q.quote.model} and ${q.quote.refs} reference picture(s)?\n\nIt costs ${q.quote.price}.`)) { genMsg.textContent = 'Not generated.'; return; }
    const r = await api('/api/human/genview', { ...req, confirm: true });
    if (r.error) { genMsg.textContent = `Not started: ${r.error}`; return; }
    genJob = r.job; genBtn.disabled = true;
    const t0 = Date.now();
    let res;
    for (;;) {
      res = await api(`/api/human/job?id=${r.job}`);
      if (!res.pending) break;
      genMsg.textContent = `Generating ${r.out.split('/').pop()}… ${Math.round((Date.now() - t0) / 1000)} s`;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    genJob = null; genBtn.disabled = false;
    if (!res.url) { genMsg.textContent = `Not generated: ${res.error ?? 'no picture'}`; return; }
    genMsg.textContent = `Generated ${res.url.split('/').pop()} in ${Math.round((res.ms ?? 0) / 1000)} s${res.cost != null ? `, ${res.cost.toFixed(3)} USD` : ''}; it lies over the view: paint with the Picture brush`;
    refs.push(res.url);
    await setPic(res.url);
    P.tool = 'picture'; cardsSync();
  };

  const undoBtn = el('button', null, 'Undo'), redoBtn = el('button', null, 'Redo');
  undoBtn.title = 'Ctrl+Z'; redoBtn.title = 'Ctrl+Shift+Z';
  undoBtn.onclick = () => step(undo, redo); redoBtn.onclick = () => step(redo, undo);
  const hist = el('div', 'hu-btns'); hist.append(undoBtn, redoBtn);
  const saveBtn = el('button', 'primary', 'Save the painting');
  saveBtn.title = 'A new <name>_paint_v<n>_color.png on MPFB\'s UV (never overwritten), padded around the UV islands; Finished model picks it as the colour map';
  const closeBtn = el('button', null, 'Close');
  const endRow = el('div', 'hu-btns'); endRow.append(saveBtn, closeBtn);
  const infoEl = el('div', 'note'), msg = el('div', 'note');
  const help = el('div', 'note', 'Left drag paints · middle drag or Alt+drag turns · right drag pans · Shift+drag moves the picture, Ctrl+Shift+drag turns it, Shift+wheel scales it · Ctrl+click picks a colour · [ ] radius · H hides the picture');
  rows.append(
    baseRow, skinRow,
    seg('Brush', [['color', 'Colour', 'Paints the colour below'], ['picture', 'Picture', 'Paints from the reference picture, where it lies over the figure'], ['blur', 'Blur', 'Softens what is painted'], ['erase', 'Erase', 'Back to the base']], 'tool'),
    colorRow('Colour', 'color', 'The brush colour (Ctrl+click on the figure or the picture picks one)'),
    slider('Radius (px)', 'radius', 3, 400, 1, 'The brush radius on screen ([ and ])'),
    slider('Strength', 'strength', 0.02, 1, 0.01, 'How much each dab covers'),
    slider('Hardness', 'hard', 0, 0.95, 0.01, 'How much of the radius paints fully before it softens'),
    slider('Edge fade', 'face', -0.2, 0.8, 0.01, 'Surfaces turned away from you get less paint, so a front picture does not smear over the sides'),
    toggle('Mirror in x', 'paint both sides', 'mirror', 'The other side gets the same paint, mirrored (the body is symmetric)'),
    viewRow,
    el('div', 'hu-sub', 'Reference pictures'), picList,
    slider('Picture opacity', 'opacity', 0.05, 1, 0.01, 'How strongly the picture shows over the view (it paints at full strength)', placePic),
    slider('Picture size', 'size', 0.1, 6, 0.01, 'The picture\'s size (Shift+wheel)', placePic),
    slider('Picture turn', 'rot', -180, 180, 0.5, 'The picture\'s angle in degrees (Ctrl+Shift+drag)', placePic),
    toggle('Flip the picture', 'mirror it left to right', 'flip', 'A picture of the other side', placePic),
    picBtns,
    el('div', 'hu-sub', 'A new picture for this angle'), promptEl, genBtn, genMsg,
    toggle('Lit', 'off shows the flat colour', 'lit', 'With lighting, or the painted colour alone', () => applyMat()),
    hist, infoEl, help, endRow, msg,
  );
  side.prepend(card);
  card.hidden = true;
  function updateInfo() {
    undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length;
    saveBtn.disabled = !dirty;
    infoEl.textContent = `${name ?? ''}: ${N} × ${N} on MPFB's UV · base ${P.base ? P.base.split('/').pop() : `skin ${P.skin}`}${dirty ? ' · unsaved' : ''}`;
  }
  function applyMat() { if (body) body.material = P.lit ? litMat : flatMat; }

  // --- Spara: pixlarna ur målet, påfyllning runt öarna (texlar utanför fylls från grannarna), PNG till servern ---
  async function pixels() {
    const a = new Uint8Array(N * N * 4), m = new Uint8Array(N * N * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, N, N, a);
    renderer.readRenderTargetPixels(maskRt, 0, 0, N, N, m);
    let cov = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) cov[i] = m[4 * i] > 127 ? 1 : 0;
    for (let pass = 0; pass < 12; pass++) {
      const next = cov.slice();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = y * N + x;
        if (cov[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, y > 0 ? i - N : -1, y < N - 1 ? i + N : -1]) {
          if (j >= 0 && cov[j]) { r += a[4 * j]; g += a[4 * j + 1]; b += a[4 * j + 2]; n++; }
        }
        if (n) { a[4 * i] = r / n; a[4 * i + 1] = g / n; a[4 * i + 2] = b / n; next[i] = 1; }
      }
      cov = next;
    }
    for (let i = 0; i < N * N; i++) a[4 * i + 3] = 255;
    return a;
  }
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    msg.textContent = 'Saving the painting…';
    const a = await pixels();
    const cv = document.createElement('canvas'); cv.width = cv.height = N;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(a.buffer), N, N), 0, 0); // rad 0 är v = 0, PNG:ns översta rad (glTF)
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    const r = await fetch(`/api/human/paint?name=${encodeURIComponent(name)}&base=${encodeURIComponent(P.base ?? P.skin)}`, { method: 'POST', body: blob }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    if (r.error) { msg.textContent = `Not saved: ${r.error}`; saveBtn.disabled = false; return; }
    dirty = false; lastSaved = r.file;
    msg.textContent = `Saved ${r.file.split('/').pop()} (${(r.bytes / 1e6).toFixed(1)} MB); Finished model can use it as the colour map`;
    updateInfo();
    onSavedCb?.(r);
  };
  let lastSaved = null, onSavedCb = null;
  closeBtn.onclick = () => { if (dirty && !confirm('Close and drop the unsaved painting?')) return; close(); };

  function close() {
    active = false; card.hidden = true; picEl.hidden = true; ringEl.hidden = true;
    side.classList.remove('hu-painting');
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    onCloseCb?.();
  }
  let onCloseCb = null;
  return {
    async start(f, { onSaved, onClose } = {}) {
      fig = f; name = f.name; onSavedCb = onSaved; onCloseCb = onClose;
      const root = getFigure();
      body = null;
      root?.traverse((o) => { if (o.isMesh && !/eye|low-poly/i.test(`${o.name} ${o.userData.own?.name ?? ''}`) && (!body || o.geometry.attributes.position.count > body.geometry.attributes.position.count)) body = o; });
      if (!body?.geometry.attributes.uv) { say(`${name} has no body mesh with UVs to paint`); return false; }
      geo?.dispose(); lineGeo?.dispose();
      [geo, lineGeo] = buildGeometry(body);
      setScenes(); renderMask();
      for (const x of [...undo.splice(0), ...redo.splice(0)]) spare.push(x);
      refs = [...(f.refs ?? [])];
      baseSel.replaceChildren(...(f.maps?.color ?? []).map((m) => Object.assign(el('option', null, m.split('/').slice(-1)[0]), { value: m })), Object.assign(el('option', null, 'Even skin colour'), { value: '' }));
      await setBase(f.maps?.color?.[0] ?? null);
      baseSel.value = P.base ?? '';
      dirty = false;
      active = true; card.hidden = false;
      side.classList.add('hu-painting'); side.scrollTop = 0;
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE; // vänster fångas av penseln (Alt vrider)
      applyMat();
      await setPic(pic && refs.includes(pic.url) ? pic.url : null);
      cardsSync(); updateInfo();
      say(`Painting ${name}: drag on the figure; add a reference picture in the Paint card`);
      return true;
    },
    close, get active() { return active; }, get dirty() { return dirty; }, get lastSaved() { return lastSaved; },
    relayout() { if (active && pic) placePic(); },
    // För prov: penseldrag i vyns CSS-pixlar, en texel ur målet, inställningar, bildens läge
    test: {
      set: (k, v) => { P[k] = v; cardsSync(); },
      stroke: (pts) => { snapshot(); prepare(); for (const [x, y] of pts) dab(x, y); updateInfo(); },
      project: () => projBtn.onclick(),
      texel: (u, v) => { const px = new Uint8Array(4); renderer.readRenderTargetPixels(rt, Math.min(N - 1, Math.floor(u * N)), Math.min(N - 1, Math.floor(v * N)), 1, 1, px); return [...px.slice(0, 3)]; },
      hit: (x, y) => { const h = hit(x, y); return h ? { uv: [h.uv.x, h.uv.y], p: h.point.toArray() } : null; },
      screen: (p) => { const r = view.getBoundingClientRect(), v = new THREE.Vector3(...p).project(getCam()); return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height]; },
      setPic, viewShot, genRefs, get prompt() { return promptEl.value; }, get pic() { return pic && { url: pic.url, cx: pic.cx, cy: pic.cy, w: pic.w, h: pic.h }; }, get cx() { return dabMat.uniforms.uCx.value; },
      undo: () => step(undo, redo), get P() { return { ...P }; }, picColor,
    },
  };
}
