import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { AREAS, GYRI } from "./aree.js";

const $ = (s) => document.querySelector(s);
const canvas = $("#canvas"), tip = $("#tip"), marks = $("#marks");
const HEMIS = ["lh", "rh"], SIDE = { lh: "left", rh: "right" };
const ras = (x, y, z) => new THREE.Vector3(x, z, -y); // RAS (right, anterior, superior) -> three (y up)

// ---------- data ----------
const DATA = "data";
const bin = async (f, T) => new T(await (await fetch(`${DATA}/${f}`)).arrayBuffer());
const meta = await (await fetch(`${DATA}/meta.json`)).json();
// centre of the cerebrum in surface RAS mm: middle of the MRI bounding box, raised a little above the cerebellum
const CENTER = new THREE.Vector3(...meta.volume.origin.map((o, k) => o + meta.volume.shape[k] / 2 + (k === 2 ? 9 : 0)));
const data = {};
await Promise.all(HEMIS.map(async (h) => {
  const [pial, infl, nP, nI, faces, ba, gy, sulc] = await Promise.all([
    bin(`${h}.pial.f32`, Float32Array), bin(`${h}.infl.f32`, Float32Array),
    bin(`${h}.pial.n8`, Int8Array), bin(`${h}.infl.n8`, Int8Array),
    bin(`${h}.faces.u32`, Uint32Array), bin(`${h}.ba.u8`, Uint8Array),
    bin(`${h}.aparc.u8`, Uint8Array), bin(`${h}.sulc.i8`, Int8Array)]);
  data[h] = { pial, infl, nP, nI, faces, ba, gy, sulc, ids: [ba, gy] };
}));
const [volT1, volBA] = await Promise.all([bin("vol.t1.u8", Uint8Array), bin("vol.ba.u8", Uint8Array)]);

// ---------- palette: quiet tints, the boundaries and the numbers carry the map ----------
const BASE = [232, 228, 219];
function hsl(h, s, l) {
  const f = (n) => { const k = (n + h / 30) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
const nGyri = meta.aparc.length;
const pal = new Uint8Array(256 * 2 * 4);
for (let m = 0; m < 2; m++) for (let i = 0; i < 256; i++) {
  const empty = i === 0 || i === 255 || (m === 1 && i >= nGyri);
  pal.set([...(empty ? BASE : hsl((i * 137.508 + (m ? 40 : 0)) % 360, [0.3, 0.2, 0.36][i % 3], [0.6, 0.72, 0.5, 0.66][i % 4])), 255], (m * 256 + i) * 4);
}
const palTex = new THREE.DataTexture(pal, 256, 2, THREE.RGBAFormat);
palTex.magFilter = palTex.minFilter = THREE.NearestFilter;
palTex.needsUpdate = true;

// ---------- index entries, overlaps, label anchors ----------
const gyrus = (i) => GYRI[meta.aparc[i]];
const known = (m, id) => (m === 0 ? id > 0 && id < 255 && !!AREAS[id] : id > 0 && !!gyrus(id));
const cross = new Uint32Array(256 * nGyri), total = [new Uint32Array(256), new Uint32Array(nGyri)];
const stats = { lh: [{}, {}], rh: [{}, {}] }; // per hemisphere, per map, per id: mean normal, inflated centroid, anchor vertex
for (const h of HEMIS) {
  const { ba, gy, nP, infl, sulc, ids } = data[h];
  for (let i = 0; i < ba.length; i++) {
    cross[ba[i] * nGyri + gy[i]]++; total[0][ba[i]]++; total[1][gy[i]]++;
    for (let m = 0; m < 2; m++) {
      const s = (stats[h][m][ids[m][i]] ||= { n: [0, 0, 0], c: [0, 0, 0], k: 0, v: -1, best: Infinity });
      s.k++;
      for (let j = 0; j < 3; j++) { s.n[j] += nP[3 * i + j]; s.c[j] += infl[3 * i + j]; }
    }
  }
  for (let m = 0; m < 2; m++) for (const s of Object.values(stats[h][m])) s.c = s.c.map((v) => v / s.k);
  // anchor: the vertex nearest the centroid on the inflated surface, preferring gyral crowns over sulci
  for (let i = 0; i < ba.length; i++) for (let m = 0; m < 2; m++) {
    const s = stats[h][m][ids[m][i]], depth = Math.max(0, sulc[i] / 127) * 40;
    const d = (infl[3 * i] - s.c[0]) ** 2 + (infl[3 * i + 1] - s.c[1]) ** 2 + (infl[3 * i + 2] - s.c[2]) ** 2 + depth * depth;
    if (d < s.best) { s.best = d; s.v = i; }
  }
}
const ENTRIES = [
  Object.keys(AREAS).map(Number).filter((n) => total[0][n] > 0).map((n) => ({
    id: n, num: AREAS[n].unnumbered ? "" : String(n), title: AREAS[n].name,
    text: `${n} ${AREAS[n].name} ${AREAS[n].location} ${AREAS[n].fn}`.toLowerCase() })),
  meta.aparc.map((k, i) => i).filter((i) => known(1, i) && total[1][i] > 0).map((i) => ({
    id: i, num: "", title: gyrus(i).name, text: `${gyrus(i).name} ${gyrus(i).location} ${gyrus(i).fn}`.toLowerCase() }))
    .sort((a, b) => a.title.localeCompare(b.title, "en")),
];
function overlaps(m, id) { // m=0: gyri containing the area; m=1: areas falling in the gyrus
  const out = [];
  if (m === 0) { for (let g = 1; g < nGyri; g++) if (gyrus(g)) out.push([gyrus(g).name, cross[id * nGyri + g] / total[0][id]]); }
  else for (let b = 1; b < 255; b++) if (AREAS[b]) out.push([b === 48 ? "Insula" : `Area ${b}`, cross[b * nGyri + id] / total[1][id]]);
  const rows = out.filter((r) => r[1] >= 0.08).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return "No area assigned";
  return `<table>${rows.map(([n, p]) => `<tr><td>${n}</td><td class="pc">${Math.round(p * 100)}%</td><td class="bar"><b style="width:${Math.round(p * 100)}%"></b></td></tr>`).join("")}</table>`;
}

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 10, 3000);
const controls = new OrbitControls(camera, canvas);
controls.target.copy(ras(CENTER.x, CENTER.y, CENTER.z));
controls.enableDamping = true; controls.dampingFactor = 0.12;
controls.minDistance = 120; controls.maxDistance = 1200;
controls.addEventListener("change", () => (dirty = true));
const group = new THREE.Group();
group.rotation.x = -Math.PI / 2; // RAS -> y up
scene.add(group);

const U = {
  uPal: { value: palTex }, uMode: { value: 0 }, uSel: { value: -1 }, uHov: { value: -1 }, uMix: { value: 0 },
  uPick: { value: 0 }, uCut: { value: -1 }, uCutPos: { value: 0 }, uSide: { value: 1 },
};
const GLSL_COLOR = /* glsl */ `
uniform sampler2D uPal; uniform int uMode; uniform float uSel, uHov;
const vec3 BASE = vec3(0.910, 0.894, 0.859);
const vec3 ACCENT = vec3(0.878, 0.584, 0.110);
vec3 areaColor(float id) {
  vec3 p = texelFetch(uPal, ivec2(int(id + 0.5), uMode), 0).rgb;
  float has = (id > 0.5 && id < 254.5) ? 1.0 : 0.0;
  float sel = abs(id - uSel) < 0.5 ? 1.0 : 0.0;
  float hov = abs(id - uHov) < 0.5 ? has : 0.0;
  vec3 c = uSel < 0.0 ? mix(BASE, p, 0.46 * has) : mix(mix(BASE, p, 0.12 * has), ACCENT, sel);
  return c * (1.0 - 0.12 * hov * (1.0 - sel));
}`;

const cortexMaterial = (hemi) => new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: { ...U, uHemi: { value: hemi } },
  vertexShader: /* glsl */ `
    attribute vec3 posB; attribute vec3 normalB; attribute float ba; attribute float gy; attribute float sulc;
    uniform float uMix;
    ${GLSL_COLOR}
    varying vec3 vN; varying vec3 vCol; varying float vSulc; varying vec3 vP; varying float vId;
    flat varying vec3 vIds;
    void main() {
      vId = uMode == 0 ? ba : gy;
      vCol = areaColor(vId);
      vSulc = sulc; vIds = vec3(ba, gy, 0.0);
      vP = mix(position, posB, uMix);
      vN = normalMatrix * normalize(mix(normal, normalB, uMix));
      gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform int uPick; uniform float uHemi, uCut, uCutPos, uSide, uMix;
    varying vec3 vN; varying vec3 vCol; varying float vSulc; varying vec3 vP; varying float vId;
    flat varying vec3 vIds;
    void main() {
      if (uCut > -0.5) {
        float c = uCut < 0.5 ? vP.x : (uCut < 1.5 ? vP.y : vP.z);
        if (uSide * (c - uCutPos) > 0.0) discard;
      }
      if (uPick == 1) { gl_FragColor = vec4(vIds.x / 255.0, (uHemi + 1.0) / 255.0, vIds.y / 255.0, 1.0); return; }
      if (!gl_FrontFacing) { gl_FragColor = vec4(0.80, 0.78, 0.74, 1.0); return; }
      float d = max(normalize(vN).z, 0.0);
      float light = 0.52 + 0.48 * pow(d, 0.8);
      light *= 1.0 - mix(0.24, 0.10, uMix) * smoothstep(-0.15, 0.55, vSulc);
      float border = fwidth(vId) > 0.0001 ? 1.0 : 0.0; // triangles that straddle two areas
      gl_FragColor = vec4(vCol * light * (1.0 - 0.42 * border), 1.0);
    }`,
});

const mesh = {};
for (const [k, h] of HEMIS.entries()) {
  const d = data[h], g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(d.pial, 3));
  g.setAttribute("posB", new THREE.BufferAttribute(d.infl, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(d.nP, 3, true));
  g.setAttribute("normalB", new THREE.BufferAttribute(d.nI, 3, true));
  g.setAttribute("ba", new THREE.BufferAttribute(d.ba, 1));
  g.setAttribute("gy", new THREE.BufferAttribute(d.gy, 1));
  g.setAttribute("sulc", new THREE.BufferAttribute(d.sulc, 1, true));
  g.setIndex(new THREE.BufferAttribute(d.faces, 1));
  mesh[h] = new THREE.Mesh(g, cortexMaterial(k));
  mesh[h].frustumCulled = false;
  group.add(mesh[h]);
}

// ---------- section: a plane showing the T1 volume and the areas in the cortical ribbon ----------
const [vx, vy, vz] = meta.volume.shape, origin = new THREE.Vector3(...meta.volume.origin);
const tex3 = (arr, filter) => {
  const t = new THREE.Data3DTexture(arr, vx, vy, vz);
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType; t.unpackAlignment = 1;
  t.minFilter = t.magFilter = filter; t.needsUpdate = true; return t;
};
const US = { ...U, uT1: { value: tex3(volT1, THREE.LinearFilter) }, uLab: { value: tex3(volBA, THREE.NearestFilter) },
  uOrigin: { value: origin }, uSize: { value: new THREE.Vector3(vx, vy, vz) }, uVis: { value: new THREE.Vector2(1, 1) } };
const slice = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
  side: THREE.DoubleSide, uniforms: US,
  vertexShader: /* glsl */ `
    uniform float uCut, uCutPos; uniform vec3 uOrigin, uSize; varying vec3 vP;
    void main() {
      vec3 a = uOrigin, b = uOrigin + uSize;
      if (uCut < 0.5) vP = vec3(uCutPos, mix(a.y, b.y, uv.x), mix(a.z, b.z, uv.y));
      else if (uCut < 1.5) vP = vec3(mix(a.x, b.x, uv.x), uCutPos, mix(a.z, b.z, uv.y));
      else vP = vec3(mix(a.x, b.x, uv.x), mix(a.y, b.y, uv.y), uCutPos);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    precision highp sampler3D;
    uniform sampler3D uT1, uLab; uniform vec3 uOrigin, uSize; uniform vec2 uVis; uniform int uPick;
    ${GLSL_COLOR}
    varying vec3 vP;
    void main() {
      if ((vP.x < 0.0 ? uVis.x : uVis.y) < 0.5) discard;
      vec3 q = (vP - uOrigin) / uSize;
      float t = texture(uT1, q).r;
      if (t < 0.06) discard;
      float id = uMode == 0 ? floor(texture(uLab, q).r * 255.0 + 0.5) : 0.0;
      if (uPick == 1) { gl_FragColor = vec4(id / 255.0, (vP.x < 0.0 ? 1.0 : 2.0) / 255.0, 0.0, 1.0); return; }
      vec3 g = mix(vec3(0.20, 0.195, 0.185), vec3(0.957, 0.949, 0.929), smoothstep(0.15, 0.95, t));
      vec3 p = texelFetch(uPal, ivec2(int(id + 0.5), uMode), 0).rgb * 0.82;
      vec3 c = id < 0.5 ? g : (uSel < 0.0 ? mix(g, p, 0.9) : (abs(id - uSel) < 0.5 ? ACCENT : mix(g, p, 0.3)));
      gl_FragColor = vec4(c, 1.0);
    }`,
}));
slice.frustumCulled = false; slice.visible = false;
group.add(slice);

// ---------- interface state ----------
let dirty = true, mode = 0, selected = -1, hovered = -1, cutAxis = -1, anim = null, hemis = "both";
const DIST = 540;

// Camera moves are orbits: azimuth and elevation are interpolated separately (azimuth the short way round),
// so the horizon stays level and the path never tumbles over a pole. OrbitControls rests meanwhile.
const sph = new THREE.Spherical();
function flyTo(dirRAS, ms = 800) {
  const from = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
  const to = new THREE.Spherical().setFromVector3(ras(dirRAS.x, dirRAS.y, dirRAS.z));
  to.phi = Math.min(Math.PI - 0.03, Math.max(0.03, to.phi));
  let dTheta = to.theta - from.theta;
  dTheta -= Math.round(dTheta / (2 * Math.PI)) * 2 * Math.PI;
  if (from.phi < 0.06 || from.phi > Math.PI - 0.06) { from.theta = to.theta; dTheta = 0; } // leaving a pole: azimuth is free
  const r1 = Math.min(Math.max(from.radius, 380), DIST);
  anim = { t0: performance.now(), ms, from, dTheta, dPhi: to.phi - from.phi, dR: r1 - from.radius };
  controls.enabled = false;
  dirty = true;
}
function setHemis(which) {
  hemis = which;
  mesh.lh.visible = which !== "rh"; mesh.rh.visible = which !== "lh";
  US.uVis.value.set(+mesh.lh.visible, +mesh.rh.visible);
  document.querySelectorAll("[data-hemis]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.hemis === which));
  dirty = true;
}
const VIEWS = {
  lateral: () => [hemis === "rh" ? 1 : -1, 0, 0.05],
  medial: () => { if (hemis === "both") setHemis("lh"); return [hemis === "rh" ? -1 : 1, 0, 0.05]; },
  superior: () => [0, -0.02, 1], inferior: () => [0, 0.02, -1],
  anterior: () => [0, 1, 0.05], posterior: () => [0, -1, 0.05],
};
{
  const box = $("#views"), sides = $("#hemis");
  for (const [k, label] of [["both", "both"], ["lh", "left"], ["rh", "right"]]) {
    const b = document.createElement("button");
    b.textContent = label; b.dataset.hemis = k; b.setAttribute("aria-pressed", k === "both");
    b.onclick = () => setHemis(k);
    sides.append(b);
  }
  for (const k of Object.keys(VIEWS)) {
    const b = document.createElement("button");
    b.textContent = k;
    b.onclick = () => flyTo(new THREE.Vector3(...VIEWS[k]()));
    box.append(b);
  }
}

function setMap(m) {
  mode = m; U.uMode.value = m; select(-1);
  document.querySelectorAll("[data-map]").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.map === m));
  $("#find").value = ""; buildIndex(); buildMarks();
}
document.querySelectorAll("[data-map]").forEach((b) => (b.onclick = () => setMap(+b.dataset.map)));

const inflate = $("#inflate"), cut = $("#cut");
inflate.oninput = () => { if (+inflate.value > 0 && cutAxis >= 0) setCut(-1); U.uMix.value = +inflate.value; dirty = true; };

function setCut(axis) {
  cutAxis = axis; U.uCut.value = axis; slice.visible = axis >= 0;
  document.querySelectorAll("[data-cut]").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.cut === axis));
  cut.hidden = $("#flip").hidden = axis < 0;
  if (axis >= 0) {
    inflate.value = 0; U.uMix.value = 0;
    U.uSide.value = axis === 0 ? -1 : 1;
    cut.value = axis === 0 ? 0.36 : 0.5;
    setHemis("both");
    flyTo(new THREE.Vector3(...[[-1, 0.5, 0.35], [0.7, 1, 0.4], [-0.4, -0.7, 1]][axis]));
  }
  moveCut();
}
function moveCut() {
  if (cutAxis < 0) { $("#mm").textContent = ""; dirty = true; return; }
  const o = meta.volume.origin[cutAxis], n = meta.volume.shape[cutAxis];
  const p = o + 4 + (n - 8) * +cut.value;
  U.uCutPos.value = p;
  $("#mm").textContent = `${"xyz"[cutAxis]} = ${p.toFixed(0).replace("-", "−")} mm`;
  dirty = true;
}
cut.oninput = moveCut;
$("#flip").onclick = () => {
  U.uSide.value *= -1;
  const d = camera.position.clone().sub(controls.target), e = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)][cutAxis];
  d.addScaledVector(e, -2 * d.dot(e)); // mirror the camera across the cutting plane
  flyTo(new THREE.Vector3(d.x, -d.z, d.y));
};
document.querySelectorAll("[data-cut]").forEach((b) => (b.onclick = () => setCut(+b.dataset.cut)));

// ---------- index and card ----------
const items = $("#items"), card = $("#card");
function buildIndex() {
  const q = $("#find").value.trim().toLowerCase();
  items.classList.toggle("plain", mode === 1);
  items.replaceChildren(...ENTRIES[mode].filter((v) => !q || v.text.includes(q)).map((v) => {
    const li = document.createElement("li");
    li.dataset.id = v.id;
    if (mode === 0) { const n = document.createElement("span"); n.className = "n"; n.textContent = v.num; li.append(n); }
    const t = document.createElement("span"); t.className = "t"; t.textContent = v.title; li.append(t);
    li.onclick = () => select(v.id === selected ? -1 : v.id, null, true);
    li.onmouseenter = () => hover(v.id); li.onmouseleave = () => hover(-1);
    if (v.id === selected) li.classList.add("sel");
    return li;
  }));
}
$("#find").oninput = buildIndex;

function drawCard() {
  if (selected < 0) {
    card.innerHTML = "";
  } else if (mode === 1) {
    const g = gyrus(selected);
    card.innerHTML = `<h2 class="sans">${g.name}</h2><p class="sub">Desikan–Killiany region</p>
      <dl><dt>Location</dt><dd>${g.location}</dd><dt>Function</dt><dd>${g.fn}</dd><dt>Areas</dt><dd>${overlaps(1, selected)}</dd></dl>`;
  } else {
    const a = AREAS[selected], plate = selected <= 3 ? "3-1-2" : selected;
    card.innerHTML = `<h2 class="sans">${a.unnumbered ? "Insula" : `Area ${selected}`}</h2><p class="sub">${a.unnumbered ? "No Brodmann number in this annotation" : a.name}</p>
      <dl><dt>Location</dt><dd>${a.location}</dd><dt>Function</dt><dd>${a.fn}</dd><dt>Gyri</dt><dd>${overlaps(0, selected)}</dd></dl>
      ${a.unnumbered ? "" : `<figure><img src="tavole/${plate}.png" alt="Brodmann's plate, area ${selected}" loading="lazy">
        <figcaption>K. Brodmann, 1909. Lateral and medial surfaces.</figcaption></figure>`}`;
  }
  const img = card.querySelector("img");
  if (img) img.onerror = () => img.closest("figure").remove();
}

function select(id, hemi = null, move = false) {
  selected = id; U.uSel.value = id; dirty = true;
  items.querySelectorAll("li").forEach((li) => li.classList.toggle("sel", +li.dataset.id === id));
  drawCard();
  if (id < 0 || !move || cutAxis >= 0) return;
  // look along the mean normal of the area; if it faces the midline, hide the other hemisphere
  const h = hemi || (hemis === "rh" ? "rh" : "lh"), s = stats[h][mode][id];
  if (!s) return;
  const d = new THREE.Vector3(...s.n).normalize();
  if ((h === "lh" ? d.x : -d.x) >= 0.3) setHemis(h); else if (hemis !== "both" && hemis !== h) setHemis("both");
  d.z = Math.max(-0.75, Math.min(0.75, d.z)); // no views from straight above or below
  flyTo(d);
}
function hover(id) {
  if (id === hovered) return;
  hovered = id; U.uHov.value = id; dirty = true;
  items.querySelectorAll("li").forEach((li) => li.classList.toggle("hov", +li.dataset.id === id));
}

// ---------- direct labels: the area numbers sit on the cortex, as on Brodmann's plates ----------
let labels = [];
// up to 60 possible anchors per area: gyral crowns spread over the area, the most central one first
function candidates(h, id, s) {
  const { ba, sulc } = data[h], crown = [], any = [];
  for (let i = 0; i < ba.length; i++) if (ba[i] === id) (sulc[i] / 127 < 0.12 ? crown : any).push(i);
  const pool = crown.length >= 20 ? crown : crown.concat(any), step = Math.max(1, Math.floor(pool.length / 60));
  return [s.v, ...pool.filter((_, k) => k % step === 0)];
}
function buildMarks() {
  labels = [];
  if (mode === 0) for (const h of HEMIS) for (const e of ENTRIES[0]) {
    const s = stats[h][0][e.id];
    if (!s || !e.num) continue;
    const el = document.createElement("span");
    el.textContent = e.num; el.style.display = "none"; // hidden until first placed
    labels.push({ el, h, id: e.id, v: s.v, c: s.c, cand: candidates(h, e.id, s) });
  }
  marks.replaceChildren(...labels.map((l) => l.el));
  dirty = true;
}
const P = new THREE.Vector3(), N = new THREE.Vector3(), V = new THREE.Vector3();
const SEEN = 3; // the id buffer is rendered at 1/3 of the canvas size
const seenTarget = new THREE.WebGLRenderTarget(1, 1);
let seen = new Uint8Array(4), seenW = 1, seenH = 1;
// While the view moves, the numbers only follow their anchors; the id buffer is read back once the view rests.
let settle = 0;
function followMarks() {
  const w = canvas.clientWidth, hgt = canvas.clientHeight, mix = U.uMix.value;
  for (const l of labels) {
    if (!l.on) continue;
    const d = data[l.h], i = 3 * l.v;
    P.set(d.pial[i], d.pial[i + 1], d.pial[i + 2]).lerp(V.set(d.infl[i], d.infl[i + 1], d.infl[i + 2]), mix);
    N.set(d.nP[i], d.nP[i + 1], d.nP[i + 2]).lerp(V.set(d.nI[i], d.nI[i + 1], d.nI[i + 2]), mix).normalize();
    P.applyMatrix4(group.matrixWorld); N.transformDirection(group.matrixWorld);
    const facing = N.dot(V.copy(camera.position).sub(P).normalize());
    P.project(camera);
    l.el.style.transform = `translate(${((P.x + 1) / 2 * w).toFixed(1)}px,${((1 - P.y) / 2 * hgt).toFixed(1)}px) translate(-50%,-50%)`;
    l.el.style.display = facing < 0.3 || !mesh[l.h].visible ? "none" : "";
  }
  clearTimeout(settle);
  settle = setTimeout(placeMarks, 140);
}
function placeMarks() {
  if (!labels.length) return;
  const w = canvas.clientWidth, hgt = canvas.clientHeight, mix = U.uMix.value;
  // a number is shown only where its own area is what the eye actually sees at that point:
  // render area ids to a small buffer and look the anchor up in it
  const sw = Math.max(1, Math.round(w / SEEN)), sh = Math.max(1, Math.round(hgt / SEEN));
  if (sw !== seenW || sh !== seenH) { seenW = sw; seenH = sh; seenTarget.setSize(sw, sh); seen = new Uint8Array(sw * sh * 4); }
  U.uPick.value = 1;
  renderer.setRenderTarget(seenTarget); renderer.clear(); renderer.render(scene, camera);
  renderer.readRenderTargetPixels(seenTarget, 0, 0, sw, sh, seen);
  renderer.setRenderTarget(null); U.uPick.value = 0;
  const eye = camera.position, own = (x, y, l) => {
    const k = 4 * (Math.min(sh - 1, Math.max(0, Math.floor((hgt - y) / SEEN))) * sw + Math.min(sw - 1, Math.max(0, Math.floor(x / SEEN))));
    return seen[k] === l.id && seen[k + 1] === (l.h === "lh" ? 1 : 2);
  };
  // score of vertex v as an anchor for label l: 0 if hidden, else how squarely it faces the eye, less its distance from the centre of the area
  const rate = (l, v) => {
    const d = data[l.h], i = 3 * v;
    P.set(d.pial[i], d.pial[i + 1], d.pial[i + 2]).lerp(V.set(d.infl[i], d.infl[i + 1], d.infl[i + 2]), mix);
    N.set(d.nP[i], d.nP[i + 1], d.nP[i + 2]).lerp(V.set(d.nI[i], d.nI[i + 1], d.nI[i + 2]), mix).normalize();
    const off = Math.hypot(d.infl[i] - l.c[0], d.infl[i + 1] - l.c[1], d.infl[i + 2] - l.c[2]);
    P.applyMatrix4(group.matrixWorld); N.transformDirection(group.matrixWorld);
    const facing = N.dot(V.copy(eye).sub(P).normalize());
    if (facing < 0.3) return 0;
    P.project(camera);
    const x = (P.x + 1) / 2 * w, y = (1 - P.y) / 2 * hgt, r = SEEN * 2;
    if (!own(x, y, l) || !own(x - r, y, l) || !own(x + r, y, l) || !own(x, y - r, l) || !own(x, y + r, l)) return 0;
    l.x = x; l.y = y;
    return facing - off / 120;
  };
  for (const l of labels) {
    let show = mesh[l.h].visible && rate(l, l.v) !== 0; // keep the current anchor for as long as it can be seen
    if (mesh[l.h].visible && !show) {
      let best = 0, bx = 0, by = 0;
      for (const v of l.cand) { const sc = rate(l, v); if (sc !== 0 && (best === 0 || sc > best)) { best = sc; l.v = v; bx = l.x; by = l.y; show = true; } }
      l.x = bx; l.y = by;
    }
    if (show) {
      l.el.style.transform = `translate(${l.x.toFixed(1)}px,${l.y.toFixed(1)}px) translate(-50%,-50%)`;
      l.el.style.opacity = selected < 0 || selected === l.id ? 1 : 0.3;
    }
    l.el.style.display = show ? "" : "none";
    l.on = show;
  }
}

// ---------- GPU picking (also works on the inflated cortex and on the section) ----------
const target = new THREE.WebGLRenderTarget(1, 1), px = new Uint8Array(4);
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  camera.setViewOffset(r.width, r.height, ev.clientX - r.left, ev.clientY - r.top, 1, 1);
  U.uPick.value = 1;
  renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, 1, 1, px);
  renderer.setRenderTarget(null); U.uPick.value = 0; camera.clearViewOffset();
  if (!px[3] || !px[1]) return null;
  const ba = px[0], gy = px[2], id = mode === 0 ? ba : gy;
  return { id: known(mode, id) ? id : -1, ba, gy, hemi: HEMIS[px[1] - 1] };
}
let down = null, waiting = false;
canvas.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
canvas.addEventListener("wheel", () => { if (anim) { anim = null; controls.enabled = true; } }, { passive: true });
canvas.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const p = pick(e);
  select(p && p.id !== selected ? p.id : -1, p?.hemi);
});
canvas.addEventListener("pointermove", (e) => {
  if (e.buttons || waiting) return;
  waiting = true;
  requestAnimationFrame(() => {
    waiting = false;
    const p = pick(e), parts = [];
    hover(p ? p.id : -1);
    canvas.classList.toggle("pick", !!p && p.id >= 0);
    if (p) {
      if (known(0, p.ba)) parts.push(p.ba === 48 ? "Insula" : `Area ${p.ba}`);
      if (known(1, p.gy) && !(p.ba === 48 && meta.aparc[p.gy] === "insula")) parts.push(gyrus(p.gy).name);
      if (parts.length) parts.push(SIDE[p.hemi]);
    }
    tip.style.display = parts.length ? "block" : "none";
    tip.textContent = parts.join(" · ");
    tip.style.left = e.clientX + "px"; tip.style.top = e.clientY + "px";
  });
});
canvas.addEventListener("pointerleave", () => { tip.style.display = "none"; hover(-1); });

// ---------- dialogs ----------
for (const id of ["help", "about"]) {
  const d = $("#" + id);
  $("#open-" + id).onclick = () => d.showModal();
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); }); // click on the backdrop
}
addEventListener("keydown", (e) => {
  if (e.target.matches("input") || document.querySelector("dialog[open]")) return;
  if (e.key === "Escape") select(-1);
  if (e.key === "?") $("#help").showModal();
});

// ---------- loop ----------
function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); dirty = true;
}
new ResizeObserver(resize).observe(canvas.parentElement);
resize();
camera.position.copy(controls.target).add(ras(-1, 0.12, 0.1).normalize().multiplyScalar(DIST));

function frame(now) {
  requestAnimationFrame(frame);
  if (anim) {
    const k = Math.min(1, (now - anim.t0) / anim.ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    sph.set(anim.from.radius + anim.dR * e, anim.from.phi + anim.dPhi * e, anim.from.theta + anim.dTheta * e);
    camera.position.setFromSpherical(sph).add(controls.target);
    camera.lookAt(controls.target);
    if (k >= 1) { anim = null; controls.enabled = true; }
    dirty = true;
  } else
  controls.update();
  if (dirty) { dirty = false; renderer.render(scene, camera); followMarks(); }
}
buildIndex(); buildMarks(); drawCard();
$("#status").textContent = "";
requestAnimationFrame(frame);
window.atlas = { select, setCut, setMap, setHemis, flyTo, U }; // for testing from the console
