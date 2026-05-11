import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { nodeColor } from './colors.js';

const NODE_BASE_RADIUS = 6.0;
const NODE_DEGREE_FACTOR = 1.4;
const HIGHLIGHT_COLOR = new THREE.Color('#ffffff');
const NORMAL_OPACITY = 0.7;
const HIGHLIGHT_OPACITY = 0.95;

const VDJ_EDGE_COLOR = new THREE.Color('#5dffaa');
const HISTORY_EDGE_COLOR = new THREE.Color('#ffb46b');
const FALLBACK_EDGE_COLOR = new THREE.Color('#7cc8ff');

function edgeColorFor(edge) {
  if (edge.type === 'vdj_link') return VDJ_EDGE_COLOR;
  if (edge.type === 'history') return HISTORY_EDGE_COLOR;
  return FALLBACK_EDGE_COLOR;
}

function nodeRadius(node) {
  return NODE_BASE_RADIUS + Math.sqrt(node.linkedCount || 0) * NODE_DEGREE_FACTOR;
}

export class GraphRenderer {
  constructor(canvas, { onHover, onClick, onBackgroundClick, onCameraChange }) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = null; // canvas CSS gradient shows through

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    this.camera.position.set(0, 0, 1000);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.onHover = onHover;
    this.onClick = onClick;
    this.onBackgroundClick = onBackgroundClick;
    this.onCameraChange = onCameraChange;

    this.nodes = [];
    this.edges = [];
    this.nodesById = new Map();
    this.colorMode = 'bpm';

    this.cameraTarget = new THREE.Vector3(0, 0, 0);
    this.zoom = 1;
    this.targetZoom = 1;
    this.targetX = 0;
    this.targetY = 0;
    this.isDragging = false;
    this.dragStart = null;
    this.lastPointerWasDrag = false;

    this.hoveredId = null;
    this.selectedId = null;
    this.visibleIds = null;
    this.visibleEdgeTypes = null;
    this.highlightedIds = null;

    // Render-on-demand bookkeeping. We only burn CPU/GPU when something
    // actually changed; otherwise the rAF loop is a no-op.
    this.needsRender = true;
    this.cameraIsAnimating = false;

    this.bindEvents();
    this.handleResize();
  }

  invalidate() {
    this.needsRender = true;
  }

  setData(nodes, edges, { colorMode } = {}) {
    this.nodes = nodes;
    this.edges = edges;
    this.nodesById = new Map(nodes.map((n) => [n.id, n]));
    if (colorMode) this.colorMode = colorMode;
    this.disposeMeshes();
    this.buildNodeMesh();
    this.buildEdgeMesh();
    this.updateNodeColors();
    this.updateEdgeGeometry();
    this.recenterCamera();
    this.invalidate();
  }

  setColorMode(mode) {
    this.colorMode = mode;
    this.updateNodeColors();
    this.invalidate();
  }

  setVisibility({ visibleNodeIds, visibleEdgeTypes }) {
    this.visibleIds = visibleNodeIds;
    this.visibleEdgeTypes = visibleEdgeTypes;
    this.updateNodeColors();
    this.updateEdgeGeometry();
    this.invalidate();
  }

  setHighlight(ids) {
    this.highlightedIds = ids ? new Set(ids) : null;
    this.updateNodeColors();
    this.updateEdgeGeometry();
    this.invalidate();
  }

  setSelected(id) {
    this.selectedId = id;
    this.updateNodeColors();
    this.updateEdgeGeometry();
    this.invalidate();
  }

  /* ─────────────────── Mesh construction ─────────────────── */

  bindEvents() {
    window.addEventListener('resize', () => this.handleResize());

    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.isDragging = false;
      if (this.onHover) this.onHover(null, null);
      this.invalidate();
    });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  handleResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    const viewSize = 200;
    this.camera.left = -viewSize * aspect;
    this.camera.right = viewSize * aspect;
    this.camera.top = viewSize;
    this.camera.bottom = -viewSize;
    this.camera.updateProjectionMatrix();
    if (this.edgeMaterial) {
      this.edgeMaterial.resolution.set(width, height);
    }
    this.invalidate();
  }

  disposeMeshes() {
    if (this.nodeMesh) {
      this.scene.remove(this.nodeMesh);
      this.nodeMesh.geometry.dispose();
      this.nodeMesh.material.dispose();
      this.nodeMesh = null;
    }
    if (this.edgeMesh) {
      this.scene.remove(this.edgeMesh);
      this.edgeMesh.geometry.dispose();
      if (this.edgeMaterial) this.edgeMaterial.dispose();
      this.edgeMesh = null;
      this.edgeMaterial = null;
    }
  }

  buildNodeMesh() {
    const positions = new Float32Array(this.nodes.length * 3);
    const colors = new Float32Array(this.nodes.length * 3);
    const sizes = new Float32Array(this.nodes.length);
    const alphas = new Float32Array(this.nodes.length);

    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i];
      positions[i * 3] = node.x ?? 0;
      positions[i * 3 + 1] = node.y ?? 0;
      positions[i * 3 + 2] = 0;
      sizes[i] = nodeRadius(node);
      alphas[i] = 1;
      const color = nodeColor(node, this.colorMode);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('nodeAlpha', new THREE.BufferAttribute(alphas, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: { pixelRatio: { value: this.renderer.getPixelRatio() } },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        attribute float nodeAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float pixelRatio;
        void main() {
          vColor = color;
          vAlpha = nodeAlpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          // Multiply by 6 so a "size=6" node is roughly 36px on screen.
          gl_PointSize = size * 6.0 * pixelRatio;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          if (vAlpha < 0.001) discard;
          vec2 uv = gl_PointCoord - 0.5;
          float dist = length(uv);
          if (dist > 0.5) discard;
          // Outer glow ring + soft body + bright core
          float outerEdge = smoothstep(0.5, 0.42, dist);
          float ring      = smoothstep(0.42, 0.34, dist) - smoothstep(0.34, 0.30, dist);
          float body      = smoothstep(0.32, 0.22, dist);
          float core      = smoothstep(0.20, 0.0, dist);

          vec3 dim   = vColor * 0.45;
          vec3 mid   = vColor;
          vec3 bright = vColor + vec3(0.30);

          vec3 color = dim;
          color = mix(color, mid, body);
          color = mix(color, bright, core);
          color += vec3(0.15) * ring;

          float alpha = outerEdge * vAlpha;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    this.nodeMesh = new THREE.Points(geometry, material);
    this.scene.add(this.nodeMesh);
  }

  buildEdgeMesh() {
    const positions = new Float32Array(this.edges.length * 6);
    const colors = new Float32Array(this.edges.length * 6);

    for (let i = 0; i < this.edges.length; i += 1) {
      const edge = this.edges[i];
      const a = this.nodesById.get(edge.source);
      const b = this.nodesById.get(edge.target);
      if (!a || !b) continue;
      positions[i * 6] = a.x;
      positions[i * 6 + 1] = a.y;
      positions[i * 6 + 2] = 0;
      positions[i * 6 + 3] = b.x;
      positions[i * 6 + 4] = b.y;
      positions[i * 6 + 5] = 0;
      const color = edgeColorFor(edge);
      for (let s = 0; s < 2; s += 1) {
        colors[i * 6 + s * 3] = color.r;
        colors[i * 6 + s * 3 + 1] = color.g;
        colors[i * 6 + s * 3 + 2] = color.b;
      }
    }

    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);

    this.edgeMaterial = new LineMaterial({
      color: 0xffffff,
      vertexColors: true,
      worldUnits: false,
      linewidth: 2.6,
      transparent: true,
      opacity: NORMAL_OPACITY,
      depthTest: false,
      dashed: false,
      alphaToCoverage: false,
    });
    this.edgeMaterial.resolution.set(this.canvas.clientWidth, this.canvas.clientHeight);

    this.edgeMesh = new LineSegments2(geometry, this.edgeMaterial);
    // computeLineDistances() is only required for dashed lines; we don't dash.
    this.edgeMesh.renderOrder = -1; // keep edges behind nodes
    this.scene.add(this.edgeMesh);
  }

  updateNodeColors() {
    if (!this.nodeMesh) return;
    const colorAttr = this.nodeMesh.geometry.getAttribute('color');
    const sizeAttr = this.nodeMesh.geometry.getAttribute('size');
    const alphaAttr = this.nodeMesh.geometry.getAttribute('nodeAlpha');

    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i];
      const visible = this.visibleIds == null || this.visibleIds.has(node.id);
      const dimmed = this.highlightedIds != null && !this.highlightedIds.has(node.id);
      const isSelected = node.id === this.selectedId;

      let color;
      let alpha;
      let radius = nodeRadius(node);
      if (!visible) {
        color = new THREE.Color(0, 0, 0);
        alpha = 0;
      } else if (isSelected) {
        color = HIGHLIGHT_COLOR.clone();
        alpha = 1;
        radius *= 1.7;
      } else if (dimmed) {
        color = nodeColor(node, this.colorMode).multiplyScalar(0.32);
        alpha = 0.45;
      } else {
        color = nodeColor(node, this.colorMode);
        alpha = 1;
      }
      colorAttr.setXYZ(i, color.r, color.g, color.b);
      sizeAttr.setX(i, radius);
      alphaAttr.setX(i, alpha);
    }
    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  updateEdgeGeometry() {
    if (!this.edgeMesh) return;
    const positions = new Float32Array(this.edges.length * 6);
    const colors = new Float32Array(this.edges.length * 6);

    let highlightedAny = false;
    for (let i = 0; i < this.edges.length; i += 1) {
      const edge = this.edges[i];
      const a = this.nodesById.get(edge.source);
      const b = this.nodesById.get(edge.target);
      if (!a || !b) continue;
      const aVisible = this.visibleIds == null || this.visibleIds.has(a.id);
      const bVisible = this.visibleIds == null || this.visibleIds.has(b.id);
      const typeVisible = !this.visibleEdgeTypes || this.visibleEdgeTypes.has(edge.type);
      const visible = aVisible && bVisible && typeVisible;

      // Collapse invisible edges to a zero-length segment (both endpoints at
      // the same point). LineSegments2 doesn't expose per-segment alpha, so a
      // hidden edge with normal opacity would otherwise leave a visible black
      // hairline at (0,0,0). Degenerate segments produce no fragments.
      if (!visible) {
        positions[i * 6] = a.x;
        positions[i * 6 + 1] = a.y;
        positions[i * 6 + 2] = 0;
        positions[i * 6 + 3] = a.x;
        positions[i * 6 + 4] = a.y;
        positions[i * 6 + 5] = 0;
        // Color is still required by the buffer layout; pick anything.
        colors[i * 6] = 0;
        colors[i * 6 + 1] = 0;
        colors[i * 6 + 2] = 0;
        colors[i * 6 + 3] = 0;
        colors[i * 6 + 4] = 0;
        colors[i * 6 + 5] = 0;
        continue;
      }

      positions[i * 6] = a.x;
      positions[i * 6 + 1] = a.y;
      positions[i * 6 + 2] = 0;
      positions[i * 6 + 3] = b.x;
      positions[i * 6 + 4] = b.y;
      positions[i * 6 + 5] = 0;

      const isHighlighted =
        this.highlightedIds != null &&
        this.highlightedIds.has(edge.source) &&
        this.highlightedIds.has(edge.target);
      if (isHighlighted) highlightedAny = true;

      const baseColor = edgeColorFor(edge);
      const intensity = isHighlighted ? 1.6 : this.highlightedIds != null ? 0.18 : 1;
      const c = baseColor.clone().multiplyScalar(intensity);

      colors[i * 6] = c.r;
      colors[i * 6 + 1] = c.g;
      colors[i * 6 + 2] = c.b;
      colors[i * 6 + 3] = c.r;
      colors[i * 6 + 4] = c.g;
      colors[i * 6 + 5] = c.b;
    }

    this.edgeMesh.geometry.setPositions(positions);
    this.edgeMesh.geometry.setColors(colors);
    this.edgeMaterial.opacity = highlightedAny ? HIGHLIGHT_OPACITY : NORMAL_OPACITY;
    this.edgeMaterial.linewidth = highlightedAny ? 4.5 : 2.6;
  }

  /* ─────────────────── Pointer + camera ─────────────────── */

  pointerToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    return new THREE.Vector3(ndcX, ndcY, 0).unproject(this.camera);
  }

  pickNode(clientX, clientY) {
    if (!this.nodeMesh) return null;
    const world = this.pointerToWorld(clientX, clientY);
    let bestId = null;
    let bestDist = Infinity;
    // Pixel-radius pick tolerance scales with zoom so it stays clickable when zoomed out.
    const worldPerPixel =
      (this.camera.right - this.camera.left) / this.canvas.clientWidth / this.zoom;
    for (const node of this.nodes) {
      const visible = this.visibleIds == null || this.visibleIds.has(node.id);
      if (!visible) continue;
      const dx = node.x - world.x;
      const dy = node.y - world.y;
      const distSq = dx * dx + dy * dy;
      const screenRadius = nodeRadius(node) * 3.0 * worldPerPixel;
      if (distSq < screenRadius * screenRadius && distSq < bestDist) {
        bestDist = distSq;
        bestId = node.id;
      }
    }
    return bestId;
  }

  onPointerDown(e) {
    this.isDragging = true;
    this.lastPointerWasDrag = false;
    this.dragStart = { x: e.clientX, y: e.clientY };
  }

  onPointerMove(e) {
    if (this.isDragging && this.dragStart) {
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.lastPointerWasDrag = true;
      const worldPerPixel =
        (this.camera.right - this.camera.left) / this.canvas.clientWidth / this.zoom;
      this.cameraTarget.x -= dx * worldPerPixel;
      this.cameraTarget.y += dy * worldPerPixel;
      this.targetX = this.cameraTarget.x;
      this.targetY = this.cameraTarget.y;
      this.camera.position.x = this.cameraTarget.x;
      this.camera.position.y = this.cameraTarget.y;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.invalidate();
      return;
    }

    const id = this.pickNode(e.clientX, e.clientY);
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      const node = id ? this.nodesById.get(id) : null;
      if (this.onHover) this.onHover(node, { x: e.clientX, y: e.clientY });
      // Hovered id changed: in auto-label mode the visible label set just
      // changed, so we need a frame to position the newly-shown label.
      this.invalidate();
    } else if (id && this.onHover) {
      // Same node still hovered — only the tooltip position needs updating;
      // no scene change, so no render needed.
      this.onHover(this.nodesById.get(id), { x: e.clientX, y: e.clientY });
    }
  }

  onPointerUp(e) {
    this.isDragging = false;
    if (this.lastPointerWasDrag) {
      this.lastPointerWasDrag = false;
      return;
    }
    const id = this.pickNode(e.clientX, e.clientY);
    if (id) {
      if (this.onClick) this.onClick(this.nodesById.get(id));
    } else if (this.onBackgroundClick) {
      this.onBackgroundClick();
    }
  }

  onWheel(e) {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0015);
    this.targetZoom = Math.max(0.15, Math.min(8, this.targetZoom * factor));
  }

  recenterCamera() {
    if (this.nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const node of this.nodes) {
      if (this.visibleIds && !this.visibleIds.has(node.id)) continue;
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x > maxX) maxX = node.x;
      if (node.y > maxY) maxY = node.y;
      count += 1;
    }
    if (count === 0) {
      // Fall back to all nodes if filtered set is empty.
      for (const node of this.nodes) {
        if (node.x < minX) minX = node.x;
        if (node.y < minY) minY = node.y;
        if (node.x > maxX) maxX = node.x;
        if (node.y > maxY) maxY = node.y;
      }
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.cameraTarget.set(cx, cy, 0);
    this.targetX = cx;
    this.targetY = cy;
    this.camera.position.x = cx;
    this.camera.position.y = cy;

    const width = maxX - minX;
    const height = maxY - minY;
    const margin = 100;
    const viewWidth = this.camera.right - this.camera.left;
    const viewHeight = this.camera.top - this.camera.bottom;
    const fitZoom = Math.min(
      viewWidth / (width + margin * 2),
      viewHeight / (height + margin * 2)
    );
    this.targetZoom = Math.max(0.2, Math.min(3.5, fitZoom));
    this.zoom = this.targetZoom;
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  flyTo(x, y, zoom) {
    this.targetX = x;
    this.targetY = y;
    this.cameraTarget.set(x, y, 0);
    if (zoom != null) this.targetZoom = zoom;
    // The animation loop will pick up the new target and start interpolating;
    // it sets needsRender each animating frame.
  }

  start() {
    // Once camera deltas drop below these thresholds we snap to target and
    // mark the camera as settled. The rAF loop then goes fully idle until
    // the next state change calls invalidate(), so the page stops burning
    // CPU/GPU when the user isn't interacting.
    const EPS_POS = 0.04;
    const EPS_ZOOM = 0.0008;

    const tick = () => {
      const dx = this.targetX - this.camera.position.x;
      const dy = this.targetY - this.camera.position.y;
      const dz = this.targetZoom - this.zoom;
      const isAnimating =
        Math.abs(dx) > EPS_POS || Math.abs(dy) > EPS_POS || Math.abs(dz) > EPS_ZOOM;

      if (isAnimating) {
        this.zoom += dz * 0.18;
        this.camera.position.x += dx * 0.22;
        this.camera.position.y += dy * 0.22;
        this.camera.zoom = this.zoom;
        this.camera.updateProjectionMatrix();
        this.cameraIsAnimating = true;
        this.needsRender = true;
      } else if (this.cameraIsAnimating) {
        // Snap once on settle so we don't asymptote forever on sub-epsilon deltas.
        this.camera.position.x = this.targetX;
        this.camera.position.y = this.targetY;
        this.zoom = this.targetZoom;
        this.camera.zoom = this.zoom;
        this.camera.updateProjectionMatrix();
        this.cameraIsAnimating = false;
        this.needsRender = true;
      }

      if (this.needsRender) {
        this.renderer.render(this.scene, this.camera);
        if (this.onCameraChange) this.onCameraChange();
        this.needsRender = false;
      }

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
