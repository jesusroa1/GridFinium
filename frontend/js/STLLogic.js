const STL_DEFAULT_DIMENSIONS = Object.freeze({
  width: 4,
  depth: 6,
  height: 3,
});

const INCH_TO_MM = 25.4;

const THREE_CDN_SOURCES = Object.freeze([
  'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.min.js',
  'https://unpkg.com/three@0.161.0/build/three.min.js',
]);

let threeLoaderPromise = null;

export function ensureThreeJs() {
  if (typeof THREE !== 'undefined') return Promise.resolve();
  if (threeLoaderPromise) return threeLoaderPromise;

  threeLoaderPromise = new Promise((resolve, reject) => {
    const trySource = (index) => {
      if (typeof THREE !== 'undefined') {
        resolve();
        return;
      }

      if (index >= THREE_CDN_SOURCES.length) {
        reject(new Error('Three.js failed to load'));
        return;
      }

      const script = document.createElement('script');
      script.src = THREE_CDN_SOURCES[index];
      script.async = true;
      script.crossOrigin = 'anonymous';

      const cleanup = () => {
        script.removeEventListener('load', handleLoad);
        script.removeEventListener('error', handleError);
      };

      const handleLoad = () => {
        cleanup();
        if (typeof THREE !== 'undefined') {
          resolve();
        } else {
          script.remove();
          trySource(index + 1);
        }
      };

      const handleError = () => {
        cleanup();
        script.remove();
        trySource(index + 1);
      };

      script.addEventListener('load', handleLoad);
      script.addEventListener('error', handleError);
      document.head.appendChild(script);
    };

    trySource(0);
  }).then(
    () => undefined,
    (error) => {
      threeLoaderPromise = null;
      throw error;
    },
  );

  return threeLoaderPromise;
}

export function initStlDesigner(options) {
  if (typeof THREE !== 'undefined') {
    return initThreeStlDesigner(options);
  }

  return initCanvasStlDesigner(options);
}

function initThreeStlDesigner({
  viewerId,
  widthInputId,
  depthInputId,
  heightInputId,
  summaryId,
  downloadButtonId,
  resetButtonId,
}) {
  const viewerRoot = document.getElementById(viewerId);
  const widthInput = document.getElementById(widthInputId);
  const depthInput = document.getElementById(depthInputId);
  const heightInput = document.getElementById(heightInputId);
  const summaryNode = document.getElementById(summaryId);
  const downloadButton = document.getElementById(downloadButtonId);
  const resetButton = document.getElementById(resetButtonId);

  if (!viewerRoot || !widthInput || !depthInput || !heightInput || !summaryNode) return null;
  if (typeof THREE === 'undefined') {
    viewerRoot.textContent = 'Three.js failed to load, so the 3D preview is unavailable.';
    return null;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.classList.add('stl-viewer__canvas');
  renderer.domElement.style.touchAction = 'none';

  const displaySize = {
    width: Math.max(1, viewerRoot.clientWidth || viewerRoot.offsetWidth || viewerRoot.scrollWidth || 480),
    height: Math.max(1, viewerRoot.clientHeight || viewerRoot.offsetHeight || viewerRoot.scrollHeight || 320),
  };

  renderer.setSize(displaySize.width, displaySize.height, false);
  viewerRoot.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(35, displaySize.width / displaySize.height, 0.1, 1000);
  camera.position.set(6, 5, 8);
  camera.lookAt(0, 0, 0);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.85);
  directionalLight.position.set(4, 8, 6);
  scene.add(directionalLight);

  const gridHelper = new THREE.GridHelper(18, 12, 0x94a3b8, 0xcbd5f5);
  gridHelper.position.y = -1.8;
  scene.add(gridHelper);

  const axesHelper = new THREE.AxesHelper(6);
  axesHelper.material.depthTest = false;
  axesHelper.material.transparent = true;
  axesHelper.material.opacity = 0.4;
  scene.add(axesHelper);

  const skyGeometry = new THREE.SphereGeometry(80, 32, 32);
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0xe0f2fe) },
      bottomColor: { value: new THREE.Color(0xf8fafc) },
      offset: { value: 40 },
      exponent: { value: 0.6 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize( vWorldPosition + offset ).y;
        gl_FragColor = vec4( mix( bottomColor, topColor, max( pow( max(h, 0.0), exponent ), 0.0 ) ), 1.0 );
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  scene.add(sky);

  const material = new THREE.MeshStandardMaterial({
    color: 0x4f46e5,
    metalness: 0.25,
    roughness: 0.38,
    envMapIntensity: 0.55,
  });

  const outlineMaterial = new THREE.LineBasicMaterial({
    color: 0x312e81,
    linewidth: 2,
  });

  const group = new THREE.Group();
  scene.add(group);

  const buildMesh = (dimensions) => {
    group.clear();

    const geometry = new THREE.BoxGeometry(dimensions.width, dimensions.height, dimensions.depth);
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);

    const edges = new THREE.EdgesGeometry(geometry);
    const outline = new THREE.LineSegments(edges, outlineMaterial);
    group.add(outline);
  };

  const controls = configureStlControls({
    widthInput,
    depthInput,
    heightInput,
    summaryNode,
    downloadButton,
    resetButton,
    onChange: (dimensions) => {
      buildMesh({
        width: dimensions.width,
        depth: dimensions.depth,
        height: dimensions.height,
      });
    },
  });

  buildMesh({
    width: controls.getDimensions().width,
    depth: controls.getDimensions().depth,
    height: controls.getDimensions().height,
  });

  const resizeRenderer = () => {
    const width = viewerRoot.clientWidth || viewerRoot.offsetWidth || viewerRoot.scrollWidth;
    const height = viewerRoot.clientHeight || viewerRoot.offsetHeight || viewerRoot.scrollHeight;

    const safeWidth = Math.max(1, width || displaySize.width);
    const safeHeight = Math.max(1, height || displaySize.height);

    displaySize.width = safeWidth;
    displaySize.height = safeHeight;

    renderer.setSize(safeWidth, safeHeight, false);
    camera.aspect = safeWidth / safeHeight;
    camera.updateProjectionMatrix();
  };

  const dragState = {
    active: false,
    pointerId: null,
    previous: { x: 0, y: 0 },
  };

  const releasePointer = (event) => {
    if (dragState.pointerId !== event.pointerId) return;
    dragState.active = false;
    dragState.pointerId = null;
    renderer.domElement.releasePointerCapture(event.pointerId);
    renderer.domElement.style.cursor = 'grab';
  };

  const handlePointerDown = (event) => {
    dragState.active = true;
    dragState.pointerId = event.pointerId;
    dragState.previous.x = event.clientX;
    dragState.previous.y = event.clientY;
    renderer.domElement.setPointerCapture(event.pointerId);
    renderer.domElement.style.cursor = 'grabbing';
  };

  const handlePointerMove = (event) => {
    if (!dragState.active || dragState.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - dragState.previous.x;
    const deltaY = event.clientY - dragState.previous.y;
    dragState.previous.x = event.clientX;
    dragState.previous.y = event.clientY;

    group.rotation.y += deltaX * 0.005;
    group.rotation.x += deltaY * 0.005;
    group.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, group.rotation.x));
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const zoomFactor = Math.exp(event.deltaY * 0.001);
    camera.position.multiplyScalar(zoomFactor);
  };

  renderer.domElement.addEventListener('pointerdown', handlePointerDown);
  renderer.domElement.addEventListener('pointermove', handlePointerMove);
  renderer.domElement.addEventListener('pointerup', releasePointer);
  renderer.domElement.addEventListener('pointercancel', releasePointer);
  renderer.domElement.addEventListener('pointerleave', () => {
    dragState.active = false;
    dragState.pointerId = null;
    renderer.domElement.style.cursor = 'grab';
  });
  renderer.domElement.addEventListener('wheel', handleWheel, { passive: false });
  window.addEventListener('resize', resizeRenderer);

  resizeRenderer();

  const animate = () => {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  };

  animate();

  return {
    getDimensions: () => controls.getDimensions(),
    reset: () => controls.reset(),
  };
}

function initCanvasStlDesigner({
  viewerId,
  widthInputId,
  depthInputId,
  heightInputId,
  summaryId,
  downloadButtonId,
  resetButtonId,
}) {
  const viewerRoot = document.getElementById(viewerId);
  const widthInput = document.getElementById(widthInputId);
  const depthInput = document.getElementById(depthInputId);
  const heightInput = document.getElementById(heightInputId);
  const summaryNode = document.getElementById(summaryId);
  const downloadButton = document.getElementById(downloadButtonId);
  const resetButton = document.getElementById(resetButtonId);

  if (!viewerRoot || !widthInput || !depthInput || !heightInput || !summaryNode) return null;

  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  canvas.classList.add('stl-viewer__canvas');

  viewerRoot.replaceChildren(canvas);

  const context = canvas.getContext('2d');
  if (!context) {
    viewerRoot.textContent = 'Your browser does not support the canvas 3D preview.';
    return null;
  }

  const faces = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [3, 2, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [0, 3, 7, 4],
  ];

  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];

  const lightDirection = normalizeVector({ x: 0.6, y: 0.85, z: 1 });
  const state = {
    rotationX: Math.PI / 10,
    rotationY: Math.PI / 8,
    zoom: 1,
  };

  const displaySize = {
    width: Math.max(1, viewerRoot.clientWidth || viewerRoot.offsetWidth || viewerRoot.scrollWidth || 480),
    height: Math.max(1, viewerRoot.clientHeight || viewerRoot.offsetHeight || viewerRoot.scrollHeight || 320),
    dpr: window.devicePixelRatio || 1,
  };

  let latestDimensions = { ...STL_DEFAULT_DIMENSIONS };
  let pendingFrame = null;

  const ensureCanvasSize = () => {
    displaySize.width = Math.max(
      1,
      viewerRoot.clientWidth || viewerRoot.offsetWidth || viewerRoot.scrollWidth || displaySize.width,
    );
    displaySize.height = Math.max(
      1,
      viewerRoot.clientHeight || viewerRoot.offsetHeight || viewerRoot.scrollHeight || displaySize.height,
    );
    displaySize.dpr = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.round(displaySize.width * displaySize.dpr));
    canvas.height = Math.max(1, Math.round(displaySize.height * displaySize.dpr));
    canvas.style.width = `${displaySize.width}px`;
    canvas.style.height = `${displaySize.height}px`;

    scheduleRender();
  };

  const scheduleRender = () => {
    if (pendingFrame) return;
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = null;
      render();
    });
  };

  const render = () => {
    const width = displaySize.width;
    const height = displaySize.height;
    if (width === 0 || height === 0) return;

    context.setTransform(displaySize.dpr, 0, 0, displaySize.dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#eef2ff');
    gradient.addColorStop(1, '#e2e8f0');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    const dims = latestDimensions;
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const maxDimension = Math.max(dims.width, dims.height, dims.depth);
    const minCanvasSize = Math.min(width, height);
    const scale = (minCanvasSize * 0.5) / (maxDimension || 1);
    const baseDistance = (maxDimension || 1) * scale * 3.2;
    const distance = baseDistance / state.zoom;
    const focalLength = distance;

    const baseVertices = buildBoxVertices(dims, scale);
    const rotatedVertices = baseVertices.map((vertex) => rotateVertex(vertex, state.rotationX, state.rotationY));
    const projectedVertices = rotatedVertices.map((vertex) => projectVertex(vertex, halfWidth, halfHeight, distance, focalLength));

    drawShadow(context, dims, maxDimension, minCanvasSize, halfWidth, halfHeight);

    const visibleFaces = faces
      .map((indices) => buildFaceData(indices, rotatedVertices, projectedVertices, distance))
      .filter((face) => face && face.viewDot < 0)
      .map((face) => ({
        ...face,
        fill: shadeColor({ r: 79, g: 70, b: 229 }, lightDirection, face.normal),
      }));

    visibleFaces.sort((a, b) => b.averageDepth - a.averageDepth);

    visibleFaces.forEach((face) => {
      context.beginPath();
      face.projected.forEach((point, index) => {
        if (index === 0) {
          context.moveTo(point.x, point.y);
        } else {
          context.lineTo(point.x, point.y);
        }
      });
      context.closePath();
      context.fillStyle = face.fill;
      context.fill();
    });

    context.beginPath();
    edges.forEach(([startIndex, endIndex]) => {
      const start = projectedVertices[startIndex];
      const end = projectedVertices[endIndex];
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
    });
    context.lineWidth = 1.2;
    context.strokeStyle = 'rgba(30, 41, 59, 0.35)';
    context.stroke();
  };

  const dragState = {
    active: false,
    pointerId: null,
    previous: { x: 0, y: 0 },
  };

  canvas.addEventListener('pointerdown', (event) => {
    dragState.active = true;
    dragState.pointerId = event.pointerId;
    dragState.previous.x = event.clientX;
    dragState.previous.y = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragState.active || dragState.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - dragState.previous.x;
    const deltaY = event.clientY - dragState.previous.y;
    dragState.previous.x = event.clientX;
    dragState.previous.y = event.clientY;

    state.rotationY += deltaX * 0.005;
    state.rotationX += deltaY * 0.005;
    state.rotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, state.rotationX));

    scheduleRender();
  });

  const releasePointer = (event) => {
    if (dragState.pointerId !== event.pointerId) return;
    dragState.active = false;
    dragState.pointerId = null;
    canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = 'grab';
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const zoomFactor = Math.exp(event.deltaY * 0.001);
    state.zoom *= zoomFactor;
    state.zoom = Math.max(0.3, Math.min(3.5, state.zoom));
    scheduleRender();
  };

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('pointerleave', () => {
    dragState.active = false;
    dragState.pointerId = null;
    canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('wheel', handleWheel, { passive: false });

  window.addEventListener('resize', ensureCanvasSize);
  ensureCanvasSize();

  const controls = configureStlControls({
    widthInput,
    depthInput,
    heightInput,
    summaryNode,
    downloadButton,
    resetButton,
    onChange: (dimensions) => {
      latestDimensions = dimensions;
      scheduleRender();
    },
  });

  return {
    getDimensions: () => controls.getDimensions(),
    reset: () => controls.reset(),
  };
}

function configureStlControls({
  widthInput,
  depthInput,
  heightInput,
  summaryNode,
  downloadButton,
  resetButton,
  onChange,
}) {
  const formatNumber = (value) => {
    const rounded = Math.round(value * 100) / 100;
    return Number.isFinite(rounded) ? rounded : 0;
  };

  const parseInput = (input) => {
    const raw = Number.parseFloat(input.value);
    return Number.isFinite(raw) ? Math.max(0.1, raw) : null;
  };

  const state = {
    width: formatNumber(STL_DEFAULT_DIMENSIONS.width),
    depth: formatNumber(STL_DEFAULT_DIMENSIONS.depth),
    height: formatNumber(STL_DEFAULT_DIMENSIONS.height),
  };

  const applyDimensions = (dimensions, options = {}) => {
    state.width = formatNumber(dimensions.width);
    state.depth = formatNumber(dimensions.depth);
    state.height = formatNumber(dimensions.height);

    if (options.commitInputs) {
      widthInput.value = state.width;
      depthInput.value = state.depth;
      heightInput.value = state.height;
    }

    updateStlSummary(summaryNode, state);
    if (typeof onChange === 'function') {
      onChange({ ...state });
    }
  };

  const syncInputsFromState = () => {
    widthInput.value = state.width;
    depthInput.value = state.depth;
    heightInput.value = state.height;
  };

  const handleLiveInput = () => {
    const width = parseInput(widthInput);
    const depth = parseInput(depthInput);
    const height = parseInput(heightInput);

    if (width === null || depth === null || height === null) {
      syncInputsFromState();
      return;
    }

    applyDimensions({ width, depth, height }, { commitInputs: false });
  };

  const commitDimensions = () => {
    const width = parseInput(widthInput);
    const depth = parseInput(depthInput);
    const height = parseInput(heightInput);

    if (width === null || depth === null || height === null) {
      syncInputsFromState();
      return;
    }

    applyDimensions({ width, depth, height }, { commitInputs: true });
  };

  const resetDimensions = () => {
    applyDimensions({ ...STL_DEFAULT_DIMENSIONS }, { commitInputs: true });
  };

  const handleDownload = () => {
    const stlContent = generateBoxStl(state);
    const fileName = buildStlFileName(state);
    const blob = new Blob([stlContent], { type: 'model/stl' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  widthInput.addEventListener('input', handleLiveInput);
  depthInput.addEventListener('input', handleLiveInput);
  heightInput.addEventListener('input', handleLiveInput);

  widthInput.addEventListener('change', commitDimensions);
  depthInput.addEventListener('change', commitDimensions);
  heightInput.addEventListener('change', commitDimensions);

  if (downloadButton) {
    downloadButton.addEventListener('click', (event) => {
      event.preventDefault();
      handleDownload();
    });
  }

  if (resetButton) {
    resetButton.addEventListener('click', (event) => {
      event.preventDefault();
      resetDimensions();
    });
  }

  resetDimensions();

  return {
    getDimensions: () => ({ ...state }),
    reset: resetDimensions,
  };
}

function updateStlSummary(summaryNode, dimensions) {
  if (!summaryNode) return;
  const { width, depth, height } = dimensions;
  const format = (value) => Math.round(value * 100) / 100;
  summaryNode.textContent = `Box dimensions: ${format(width)}" × ${format(depth)}" × ${format(height)}".`;
}

function buildBoxVertices(dimensions, scale) {
  const hx = ((dimensions.width || 0) * scale) / 2;
  const hy = ((dimensions.height || 0) * scale) / 2;
  const hz = ((dimensions.depth || 0) * scale) / 2;

  return [
    { x: -hx, y: -hy, z: -hz },
    { x: hx, y: -hy, z: -hz },
    { x: hx, y: hy, z: -hz },
    { x: -hx, y: hy, z: -hz },
    { x: -hx, y: -hy, z: hz },
    { x: hx, y: -hy, z: hz },
    { x: hx, y: hy, z: hz },
    { x: -hx, y: hy, z: hz },
  ];
}

function rotateVertex(vertex, rotationX, rotationY) {
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);
  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);

  const x1 = vertex.x * cosY - vertex.z * sinY;
  const z1 = vertex.x * sinY + vertex.z * cosY;
  const y1 = vertex.y * cosX - z1 * sinX;
  const z2 = vertex.y * sinX + z1 * cosX;

  return { x: x1, y: y1, z: z2 };
}

function projectVertex(vertex, halfWidth, halfHeight, distance, focalLength) {
  const z = vertex.z + distance;
  const perspective = focalLength / (z || 1);

  return {
    x: halfWidth + vertex.x * perspective,
    y: halfHeight - vertex.y * perspective,
    depth: z,
  };
}

function drawShadow(context, dimensions, maxDimension, minCanvasSize, centerX, centerY) {
  const safeMax = maxDimension || 1;
  const scaleWidth = (dimensions.width / safeMax) * minCanvasSize * 0.28;
  const scaleDepth = (dimensions.depth / safeMax) * minCanvasSize * 0.22;
  const offsetY = (dimensions.height / safeMax) * minCanvasSize * 0.14;

  context.save();
  context.fillStyle = 'rgba(15, 23, 42, 0.12)';
  context.beginPath();
  context.ellipse(
    centerX,
    centerY + offsetY,
    Math.max(12, scaleWidth),
    Math.max(8, scaleDepth),
    0,
    0,
    Math.PI * 2,
  );
  context.fill();
  context.restore();
}

function buildFaceData(indices, rotatedVertices, projectedVertices, cameraDistance) {
  const rotated = indices.map((index) => rotatedVertices[index]);
  const projected = indices.map((index) => projectedVertices[index]);

  const edgeA = subtractVector(rotated[1], rotated[0]);
  const edgeB = subtractVector(rotated[2], rotated[0]);
  const normal = crossVector(edgeA, edgeB);
  const normalLength = Math.hypot(normal.x, normal.y, normal.z);
  if (!normalLength) return null;
  const unitNormal = {
    x: normal.x / normalLength,
    y: normal.y / normalLength,
    z: normal.z / normalLength,
  };

  const center = rotated.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y, z: acc.z + point.z }),
    { x: 0, y: 0, z: 0 },
  );
  center.x /= rotated.length;
  center.y /= rotated.length;
  center.z /= rotated.length;

  const centerCamera = {
    x: center.x,
    y: center.y,
    z: center.z + cameraDistance,
  };

  const toCamera = {
    x: -centerCamera.x,
    y: -centerCamera.y,
    z: -centerCamera.z,
  };
  const toCameraLength = Math.hypot(toCamera.x, toCamera.y, toCamera.z) || 1;
  const unitToCamera = {
    x: toCamera.x / toCameraLength,
    y: toCamera.y / toCameraLength,
    z: toCamera.z / toCameraLength,
  };

  const averageDepth = projected.reduce((sum, point) => sum + point.depth, 0) / projected.length;

  return {
    normal: unitNormal,
    projected,
    averageDepth,
    viewDot: dotVector(unitNormal, unitToCamera),
  };
}

function shadeColor(baseColor, lightDirection, normal) {
  const dot = Math.max(0, dotVector(lightDirection, normal));
  const intensity = 0.35 + 0.65 * dot;

  const r = Math.round(Math.min(255, baseColor.r * intensity));
  const g = Math.round(Math.min(255, baseColor.g * intensity));
  const b = Math.round(Math.min(255, baseColor.b * intensity));

  return `rgb(${r}, ${g}, ${b})`;
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function subtractVector(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function crossVector(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dotVector(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function generateBoxStl(dimensions) {
  const width = dimensions.width * INCH_TO_MM;
  const depth = dimensions.depth * INCH_TO_MM;
  const height = dimensions.height * INCH_TO_MM;

  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;

  const vertices = [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, hy, -hz],
    [-hx, hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [hx, hy, hz],
    [-hx, hy, hz],
  ];

  const facets = [
    { normal: [0, 0, -1], triangles: [[0, 1, 2], [0, 2, 3]] },
    { normal: [0, 0, 1], triangles: [[4, 5, 6], [4, 6, 7]] },
    { normal: [0, 1, 0], triangles: [[3, 2, 6], [3, 6, 7]] },
    { normal: [0, -1, 0], triangles: [[0, 1, 5], [0, 5, 4]] },
    { normal: [1, 0, 0], triangles: [[1, 6, 2], [1, 5, 6]] },
    { normal: [-1, 0, 0], triangles: [[0, 7, 3], [0, 4, 7]] },
  ];

  const lines = ['solid gridfinium_box'];

  facets.forEach(({ normal, triangles }) => {
    const normalLine = `  facet normal ${normal.map((value) => value.toFixed(6)).join(' ')}`;
    triangles.forEach((triangle) => {
      lines.push(normalLine, '    outer loop');
      triangle.forEach((index) => {
        const vertex = vertices[index];
        lines.push(`      vertex ${vertex.map((value) => value.toFixed(6)).join(' ')}`);
      });
      lines.push('    endloop', '  endfacet');
    });
  });

  lines.push('endsolid gridfinium_box');
  return `${lines.join('\n')}\n`;
}

function buildStlFileName(dimensions) {
  const parts = [dimensions.width, dimensions.depth, dimensions.height].map((value) => {
    const rounded = Math.round(value * 100) / 100;
    return String(rounded).replace(/\./g, '_');
  });
  return `gridfinium-box-${parts.join('x')}.stl`;
}

