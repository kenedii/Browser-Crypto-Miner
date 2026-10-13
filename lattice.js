/* Ambient background for the miner page, in the style of tensors.vip:
   an infinite wireframe-cube lattice (three.js), faint binary rain, and a
   scrolling hex ticker. Purely decorative - the miner never depends on it. */

/* ---------- binary rain ---------- */
(function () {
  var canvas = document.getElementById('rain');
  if (!canvas) return;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ctx = canvas.getContext('2d');
  var COLORS = ['#00ff66', '#19a7ff', '#ff2a4d'];
  var HEX = '0123456789ABCDEF';
  var o = {size: 16, speed: 1, weights: [.5, .3, .2], hex: .3, mutate: .18, alpha: 1};
  var cols = [], rows = 0, w = 0, h = 0;
  function pick() { var r = Math.random(); return r < o.weights[0] ? 0 : r < o.weights[0] + o.weights[1] ? 1 : 2; }
  function glyph(hex) { return hex ? HEX[Math.random() * 16 | 0] : (Math.random() < .5 ? '0' : '1'); }
  function reset(col, first) {
    col.c = pick(); col.hex = Math.random() < o.hex;
    col.v = .25 + Math.random() * .6; col.len = 8 + (Math.random() * 26 | 0);
    col.y = first ? Math.random() * (rows + col.len) : -(Math.random() * rows * .6);
    col.chars = Array.from({length: rows + 2}, function () { return glyph(col.hex); });
  }
  function resize() {
    var dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rows = Math.ceil(h / o.size);
    cols = Array.from({length: Math.ceil(w / o.size)}, function () { var c = {}; reset(c, true); return c; });
  }
  var last = 0;
  function frame(t) {
    if (!reduce) requestAnimationFrame(frame);
    if (t - last < 33) return; last = t;
    ctx.clearRect(0, 0, w, h);
    ctx.font = o.size + 'px "Share Tech Mono", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i], x = i * o.size + o.size / 2, head = Math.floor(col.y);
      ctx.fillStyle = COLORS[col.c];
      for (var k = 1; k < col.len; k++) {
        var r = head - k; if (r < 0 || r > rows) continue;
        if (Math.random() < o.mutate) col.chars[r] = glyph(col.hex);
        ctx.globalAlpha = o.alpha * (1 - k / col.len) * .9;
        ctx.fillText(col.chars[r], x, r * o.size);
      }
      if (head >= 0 && head <= rows) {
        col.chars[head] = glyph(col.hex);
        ctx.globalAlpha = o.alpha; ctx.fillStyle = '#eafff4';
        ctx.shadowColor = COLORS[col.c]; ctx.shadowBlur = 10;
        ctx.fillText(col.chars[head], x, head * o.size);
        ctx.shadowBlur = 0;
      }
      col.y += col.v * o.speed;
      if (head - col.len > rows) reset(col, false);
    }
    ctx.globalAlpha = 1;
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas); else addEventListener('resize', resize);
  resize(); requestAnimationFrame(frame);
})();

/* ---------- hex ticker in the top strip ---------- */
(function () {
  var b = document.getElementById('tick1');
  if (!b) return;
  var cls = ['g', 'bl', 'r'], html = '';
  for (var i = 0; i < 40; i++) {
    var bits = ''; for (var k = 0; k < 8; k++) bits += Math.random() < .5 ? '0' : '1';
    var hex = '0x' + ('00000000' + ((Math.random() * 4294967296) >>> 0).toString(16)).slice(-8);
    html += '<span>' + bits + '</span> <span class="' + cls[i % 3] + '">' + hex + '</span>&nbsp;·&nbsp; ';
  }
  b.innerHTML = html + html;
})();

/* ---------- infinite wireframe-cube lattice (drag to look, click to pulse) ---------- */
(() => {
  if (!window.THREE) return;
  const canvas = document.getElementById('cubes');
  if (!canvas) return;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: false}); } catch (e) { return; }
  renderer.setClearColor(0x020504, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, .1, 200);

  const S = 9;                    // spacing between cube centres
  const C = 1.9;                  // cube half-size
  const NX = 6, NY = 5, NZ = 11;  // block half-extent in cells (wraps around the camera => infinite)
  const hash = (i, j, k) => { const h = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return h - Math.floor(h); };
  const PAL = [[0.0, 1.0, 0.45], [0.10, 0.65, 1.0], [1.0, 0.16, 0.30]];

  const cPos = [], cCtr = [], cCol = [], cSeed = [];
  const corners = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const lPos = [], lCol = [];
  const nodes = [];
  for (let i = -NX; i <= NX; i++) for (let j = -NY; j <= NY; j++) for (let k = -NZ; k <= NZ; k++) {
    const x = i * S, y = j * S, z = k * S, h = hash(i, j, k);
    const pc = PAL[h < .45 ? 1 : h < .78 ? 0 : 2];
    for (const [e0, e1] of edges) for (const v of [corners[e0], corners[e1]]) {
      cPos.push(v[0] * C, v[1] * C, v[2] * C); cCtr.push(x, y, z); cCol.push(...pc); cSeed.push(h);
    }
    nodes.push(x, y, z);
    const dim = .75;
    if (i < NX) { lPos.push(x, y, z, x + S, y, z); lCol.push(.1*dim, .65*dim, 1*dim, .1*dim, .65*dim, 1*dim); }
    if (j < NY) { lPos.push(x, y, z, x, y + S, z); lCol.push(0, dim, .45*dim, 0, dim, .45*dim); }
    if (k < NZ) { lPos.push(x, y, z, x, y, z + S); lCol.push(dim, .16*dim, .3*dim, dim, .16*dim, .3*dim); }
  }

  const uniforms = {
    uTime: {value: 0},
    uPulseO: {value: new THREE.Vector3(0, 0, -1e5)}, uPulseT: {value: -100},
    uFar: {value: NZ * S * .85}, uPx: {value: 1},
  };
  const common = `
    uniform float uTime, uPulseT, uFar; uniform vec3 uPulseO;
    varying vec3 vW; varying float vD;
    float ringAt(){ float age = uTime - uPulseT; float r = age * 42.0;
      return exp(-pow((distance(vW, uPulseO) - r) / 4.0, 2.0)) * exp(-age * .5); }
    float fogAt(){ return (1.0 - smoothstep(uFar * .2, uFar, vD)) * smoothstep(1.0, 6.0, vD); }`;
  const mat = (vs, fs) => new THREE.ShaderMaterial({uniforms, vertexShader: vs, fragmentShader: common + fs,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending});
  const cubeMat = mat(`
    uniform float uTime, uPulseT; uniform vec3 uPulseO; attribute vec3 aCtr; attribute vec3 color; attribute float aSeed;
    varying vec3 vC; varying vec3 vW; varying float vD; varying float vSeed;
    mat3 rot(vec3 a, float t){ a = normalize(a); float s = sin(t), c = cos(t), o = 1.0 - c;
      return mat3(o*a.x*a.x+c, o*a.x*a.y+a.z*s, o*a.z*a.x-a.y*s,
                  o*a.x*a.y-a.z*s, o*a.y*a.y+c, o*a.y*a.z+a.x*s,
                  o*a.z*a.x+a.y*s, o*a.y*a.z-a.x*s, o*a.z*a.z+c); }
    void main(){
      float kick = exp(-pow((distance(aCtr + modelMatrix[3].xyz, uPulseO) - (uTime - uPulseT) * 42.0) / 6.0, 2.0)) * exp(-(uTime - uPulseT) * .5);
      float breathe = 1.0 + .08 * sin(uTime * 1.3 + (aCtr.x + aCtr.y + aCtr.z) * .08) + kick * .6;
      vec3 p = rot(vec3(.35, 1.0, .2), uTime * .35 + kick * 1.5) * position * breathe + aCtr;
      vec4 w = modelMatrix * vec4(p, 1.0); vW = w.xyz; vD = distance(w.xyz, cameraPosition); vC = color; vSeed = aSeed;
      gl_Position = projectionMatrix * viewMatrix * w; }`, `
    varying vec3 vC; varying float vSeed;
    void main(){ float tw = .55 + .45 * sin(uTime * (1.0 + vSeed * 2.0) + vSeed * 40.0);
      vec3 c = mix(vC, vec3(.85, .97, 1.0), .25) * (.55 + .45 * tw) + vec3(.9, 1.0, 1.0) * ringAt() * 2.2;
      gl_FragColor = vec4(c * fogAt(), 1.0); }`);
  const linkMat = mat(`
    attribute vec3 color; varying vec3 vC; varying vec3 vW; varying float vD;
    void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vD = distance(w.xyz, cameraPosition); vC = color;
      gl_Position = projectionMatrix * viewMatrix * w; }`, `
    varying vec3 vC;
    void main(){ float flow = .35 + .65 * pow(.5 + .5 * sin(vW.x * .35 + vW.y * .35 + vW.z * .35 - uTime * 3.0), 6.0);
      gl_FragColor = vec4((vC * flow * .55 + vC * ringAt() * 2.5) * fogAt(), 1.0); }`);
  const pointMat = mat(`
    uniform float uPx; varying vec3 vW; varying float vD;
    void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vD = distance(w.xyz, cameraPosition);
      vec4 mv = viewMatrix * w; gl_PointSize = uPx * 60.0 / -mv.z; gl_Position = projectionMatrix * mv; }`, `
    void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0.0, d); a *= a;
      gl_FragColor = vec4(vec3(.7, .95, 1.0) * a * (.5 + ringAt() * 2.0) * fogAt(), 1.0); }`);

  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3));
  cg.setAttribute('aCtr', new THREE.Float32BufferAttribute(cCtr, 3));
  cg.setAttribute('color', new THREE.Float32BufferAttribute(cCol, 3));
  cg.setAttribute('aSeed', new THREE.Float32BufferAttribute(cSeed, 1));
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lPos, 3));
  lg.setAttribute('color', new THREE.Float32BufferAttribute(lCol, 3));
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.Float32BufferAttribute(nodes, 3));
  const lattice = new THREE.Group();
  lattice.add(new THREE.LineSegments(lg, linkMat), new THREE.LineSegments(cg, cubeMat), new THREE.Points(ng, pointMat));
  scene.add(lattice);
  lattice.children.forEach((c) => c.frustumCulled = false);

  // data packets that race along the edges and turn at nodes
  const PN = 140, packets = [], pp = new Float32Array(PN * 3), pc = new Float32Array(PN * 3);
  const PCOL = [[0, 1, .4], [.1, .65, 1], [1, .16, .3]];
  const DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  function spawn(p) {
    const c = camera.position;
    p.x = Math.round((c.x + (Math.random() - .5) * NX * S * 1.4) / S) * S;
    p.y = Math.round((c.y + (Math.random() - .5) * NY * S * 1.4) / S) * S;
    p.z = Math.round((c.z + (Math.random() - .5) * NZ * S * 1.4) / S) * S;
    p.d = DIRS[Math.random() * 6 | 0]; p.t = 0; p.v = 6 + Math.random() * 14; p.c = Math.random() * 3 | 0;
  }
  for (let i = 0; i < PN; i++) { const p = {}; spawn(p); p.t = Math.random() * S; packets.push(p); }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(pc, 3));
  const packetMat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `uniform float uPx; attribute vec3 color; varying vec3 vC; varying float vD;
      void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); vD = -mv.z;
        gl_PointSize = uPx * 90.0 / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uFar; varying vec3 vC; varying float vD;
      void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0.0, d); a *= a;
        float fog = 1.0 - smoothstep(uFar * .3, uFar, vD);
        gl_FragColor = vec4((vC + vec3(.35) * smoothstep(.2, 0.0, d)) * a * fog * 1.4, 1.0); }`,
  });
  const packetPts = new THREE.Points(pg, packetMat); packetPts.frustumCulled = false;
  scene.add(packetPts);

  // controls: the page scrolls normally, so there is no scroll-to-fly here -
  // the camera drifts on its own, follows the mouse a little, drags to look
  // and pulses on a click in the empty space around the panel.
  let yaw = .62, pitch = -.38, tYaw = .62, tPitch = -.38, mx = 0, my = 0;
  let vel = 0;
  const DRIFT = 2.2;
  let dragging = false, lx = 0, ly = 0, moved = 0;
  const hint = document.getElementById('hint');
  let used = false;
  const markUsed = () => { if (!used && hint) { used = true; hint.classList.add('used'); } };
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    mx = e.clientX / innerWidth * 2 - 1; my = e.clientY / innerHeight * 2 - 1;
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
    tYaw -= dx * .005; tPitch = Math.max(-1.3, Math.min(1.3, tPitch - dy * .005));
    markUsed();
  });
  addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.target !== document.documentElement && e.target !== document.body && e.target.id !== 'stage') return;
    dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
  });
  addEventListener('pointerup', (e) => {
    if (!dragging) return; dragging = false;
    if (moved < 6) pulseAt(e.clientX, e.clientY);
  });
  addEventListener('pointercancel', () => { dragging = false; });

  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
  function pulseAt(x, y) {
    v2.set(x / innerWidth * 2 - 1, -(y / innerHeight * 2 - 1));
    ray.setFromCamera(v2, camera);
    uniforms.uPulseO.value.copy(ray.ray.origin).addScaledVector(ray.ray.direction, 18);
    uniforms.uPulseT.value = uniforms.uTime.value;
    markUsed();
  }

  function resize() {
    const w = innerWidth, h = innerHeight, dpr = Math.min(devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.fov = w < 640 ? 85 : 70; camera.updateProjectionMatrix();
    uniforms.uPx.value = dpr * h / 720;
  }
  addEventListener('resize', resize); resize();

  camera.rotation.order = 'YXZ';
  camera.position.set(S * .5, S * .5, S * .5);
  const fwd = new THREE.Vector3();
  let last = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    uniforms.uTime.value += reduce ? 0 : dt;

    yaw += (tYaw - mx * .35 - yaw) * Math.min(1, dt * 4);
    pitch += (tPitch - my * .22 - pitch) * Math.min(1, dt * 4);
    camera.rotation.y = yaw; camera.rotation.x = pitch;
    camera.rotation.z = Math.sin(uniforms.uTime.value * .2) * .04;

    camera.getWorldDirection(fwd);
    camera.position.addScaledVector(fwd, (reduce ? 0 : DRIFT) * dt);

    // infinite: snap the lattice block to the cell the camera is in
    lattice.position.set(Math.round(camera.position.x / S) * S, Math.round(camera.position.y / S) * S, Math.round(camera.position.z / S) * S);

    const c = camera.position;
    for (let i = 0; i < PN; i++) {
      const p = packets[i];
      p.t += p.v * dt;
      if (p.t >= S) {
        p.x += p.d[0] * S; p.y += p.d[1] * S; p.z += p.d[2] * S; p.t -= S;
        if (Math.random() < .45) p.d = DIRS[Math.random() * 6 | 0];
        if (Math.abs(p.x - c.x) > NX * S || Math.abs(p.y - c.y) > NY * S || Math.abs(p.z - c.z) > NZ * S) spawn(p);
      }
      pp[i * 3] = p.x + p.d[0] * p.t; pp[i * 3 + 1] = p.y + p.d[1] * p.t; pp[i * 3 + 2] = p.z + p.d[2] * p.t;
      const k = PCOL[p.c]; pc[i * 3] = k[0]; pc[i * 3 + 1] = k[1]; pc[i * 3 + 2] = k[2];
    }
    pg.attributes.position.needsUpdate = true; pg.attributes.color.needsUpdate = true;

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
})();
