/* @fileoverview WebGL2 hierarchical reaction-diffusion demo main runtime (UI + simulation loop). */

(() => {
  const shaders = window.DemoShaders;
  if (!shaders) {
    alert("shaders.js 로드 실패");
    return;
  }

  const BUILD = "2025-12-26";

  const el = (id) => document.getElementById(id);
  const canvas = el("can");
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) {
    alert("WebGL2가 필요합니다.");
    return;
  }

  const extColorBufFloat = gl.getExtension("EXT_color_buffer_float");
  gl.getExtension("OES_texture_float_linear");
  if (!extColorBufFloat) {
    alert("EXT_color_buffer_float 확장이 필요합니다(대부분 최신 브라우저 지원).");
    return;
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const SIM = 256;
  const RGBA_FMT = gl.RGBA16F;
  const RGBA_TYPE = gl.HALF_FLOAT;
  const LAST_MIP_LEVEL = Math.floor(Math.log2(SIM));

  function createTexState() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      RGBA_FMT,
      SIM,
      SIM,
      0,
      gl.RGBA,
      RGBA_TYPE,
      null
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  function createTexMip() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      RGBA_FMT,
      SIM,
      SIM,
      0,
      gl.RGBA,
      RGBA_TYPE,
      null
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }

  function createFBO(tex, level = 0) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      level
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`FBO not complete (${status}) level=${level}`);
    }
    return fbo;
  }

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      throw new Error("Shader compile failed");
    }
    return s;
  }

  function program(vsSrc, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(p));
      throw new Error("Program link failed");
    }
    return p;
  }

  function uni(p, name) {
    return gl.getUniformLocation(p, name);
  }

  function drawTo(fbo, w, h, programObj, setupFn) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(programObj);
    setupFn();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  const progRD0 = program(shaders.quadVS, shaders.rdBaseFS);
  const progRDCascade = program(shaders.quadVS, shaders.rdCascadeFS);
  const progStruct = program(shaders.quadVS, shaders.structureFS);
  const progInitFromPrev = program(shaders.quadVS, shaders.initFromPrevFS);
  const progRender = program(shaders.quadVS, shaders.renderFS);

  const rd0U = {
    uState: uni(progRD0, "uState"),
    uTexel: uni(progRD0, "uTexel"),
    diffA: uni(progRD0, "diffA"),
    diffB: uni(progRD0, "diffB"),
    feed: uni(progRD0, "feed"),
    kill: uni(progRD0, "kill"),
    dt: uni(progRD0, "dt"),
    inh: uni(progRD0, "inh"),
    C: uni(progRD0, "C"),
  };
  const rdCU = {
    uState: uni(progRDCascade, "uState"),
    uPrev: uni(progRDCascade, "uPrev"),
    uTexel: uni(progRDCascade, "uTexel"),
    diffX: uni(progRDCascade, "diffX"),
    diffY: uni(progRDCascade, "diffY"),
    feed: uni(progRDCascade, "feed"),
    kill: uni(progRDCascade, "kill"),
    dt: uni(progRDCascade, "dt"),
    drive: uni(progRDCascade, "drive"),
  };
  const initPrevU = {
    uPrev: uni(progInitFromPrev, "uPrev"),
  };
  const stU = {
    uState: uni(progStruct, "uState"),
    uTexel: uni(progStruct, "uTexel"),
    gain: uni(progStruct, "gain"),
  };
  const reU = {
    uLeftTex: uni(progRender, "uLeftTex"),
    uRightTex: uni(progRender, "uRightTex"),
    uLeftChannel: uni(progRender, "uLeftChannel"),
    uRightChannel: uni(progRender, "uRightChannel"),
    C: uni(progRender, "C"),
  };

  // ============================================================
  // MODE STATE
  // ============================================================
  let currentMode = "struct";

  function createPingPong(tex0, tex1) {
    return {
      ping: { tex: tex0, fbo: createFBO(tex0) },
      pong: { tex: tex1, fbo: createFBO(tex1) },
      swap() {
        const tmp = this.ping;
        this.ping = this.pong;
        this.pong = tmp;
      },
    };
  }

  function createRDStage({ id, name, yName = null }) {
    const pp = createPingPong(createTexState(), createTexState());
    return {
      id,
      name,
      yName,
      frozen: false,
      params:
        id === 0
          ? {}
          : {
              diffX: 0.291,
              diffY: 0.359,
              feed: 0.1,
              kill: 0.1,
              drive: 2.0,
            },
      ...pp,
    };
  }

  const rdStages = [createRDStage({ id: 0, name: "Stage 0 (a,b)" })];

  const structLayers = [];
  {
    const texA = createTexMip();
    structLayers.push({
      id: 0,
      name: "A (from a gradient)",
      texture: texA,
      fbo: createFBO(texA, 0),
      fbo1x1: createFBO(texA, LAST_MIP_LEVEL),
      params: { gain: 10.0 },
      globalValue: 0.0,
    });
  }

  // ============================================================
  // INIT
  // ============================================================
  function initStage0() {
    const data = new Float32Array(SIM * SIM * 4);
    for (let i = 0; i < SIM * SIM; i++) {
      data[i * 4 + 0] = 1.0;
      data[i * 4 + 1] = 0.0;
      data[i * 4 + 2] = 0.0;
      data[i * 4 + 3] = 0.0;
    }
    function addPatch(cx, cy, r, bVal) {
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          const px = (cx + x + SIM) % SIM;
          const py = (cy + y + SIM) % SIM;
          if (x * x + y * y <= r * r) {
            const idx = (py * SIM + px) * 4;
            data[idx + 0] = 0.5;
            data[idx + 1] = bVal;
          }
        }
      }
    }
    addPatch(SIM / 2, SIM / 2, 12, 0.85);
    addPatch(SIM / 2 + 40, SIM / 2 - 30, 10, 0.75);
    addPatch(SIM / 2 - 50, SIM / 2 + 35, 9, 0.7);

    gl.bindTexture(gl.TEXTURE_2D, rdStages[0].ping.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SIM, SIM, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, rdStages[0].pong.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SIM, SIM, gl.RGBA, gl.FLOAT, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  function initCascadeStageFromPrevX(stageId) {
    const stage = rdStages[stageId];
    const prev = rdStages[stageId - 1];
    if (!stage || !prev) return;
    for (const target of [stage.ping, stage.pong]) {
      drawTo(target.fbo, SIM, SIM, progInitFromPrev, () => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prev.ping.tex);
        gl.uniform1i(initPrevU.uPrev, 0);
      });
    }
  }

  function initAll() {
    initStage0();
    for (let i = 1; i < rdStages.length; i++) initCascadeStageFromPrevX(i);
  }

  initAll();

  // ============================================================
  // UI STATE
  // ============================================================
  const params = {
    diffA: +el("diffA").value,
    diffB: +el("diffB").value,
    feed: +el("feed").value,
    kill: +el("kill").value,
    dt: +el("dt").value,
    inh: +el("inh").value,
    cSmooth: +el("cSmooth").value,
    aGain: +el("aGain").value,
  };

  function bindRange(id, key, fmt = (v) => v.toFixed(4), onChange) {
    const r = el(id);
    const o = el(id + "_o");
    const upd = () => {
      params[key] = +r.value;
      o.value = fmt(params[key]);
      if (onChange) onChange(params[key]);
    };
    r.addEventListener("input", upd);
    r.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const min = parseFloat(r.min);
        const max = parseFloat(r.max);
        const step = parseFloat(r.step);
        const delta = e.deltaY > 0 ? -step : step;
        let newVal = parseFloat(r.value) + delta * 5;
        newVal = Math.max(min, Math.min(max, newVal));
        r.value = newVal;
        upd();
      },
      { passive: false }
    );
    upd();
  }

  bindRange("diffA", "diffA", (v) => v.toFixed(3));
  bindRange("diffB", "diffB", (v) => v.toFixed(3));
  bindRange("feed", "feed", (v) => v.toFixed(4));
  bindRange("kill", "kill", (v) => v.toFixed(4));
  bindRange("dt", "dt", (v) => v.toFixed(2));
  bindRange("inh", "inh", (v) => v.toFixed(3));
  bindRange("cSmooth", "cSmooth", (v) => v.toFixed(3));
  bindRange("aGain", "aGain", (v) => v.toFixed(2), (v) => {
    const layer0 = structLayers[0];
    if (!layer0) return;
    layer0.params.gain = v;

    const layerGainInput = document.getElementById("layer0_gain");
    const layerGainOutput = document.getElementById("layer0_gain_o");
    if (layerGainInput && document.activeElement !== layerGainInput) {
      layerGainInput.value = String(v);
    }
    if (layerGainOutput) layerGainOutput.value = v.toFixed(2);
  });

  let paused = false;
  let cEnabled = true;
  let C = 0.0;

  el("pause").onclick = () => {
    paused = !paused;
    el("pause").textContent = paused ? "재생" : "일시정지";
  };
  el("reset").onclick = () => {
    initAll();
    C = 0.0;
  };
  el("seed").onclick = () => {
    initAll();
  };
  el("toggleC").onclick = () => {
    cEnabled = !cEnabled;
    el("toggleC").textContent = cEnabled ? "C 억제: ON" : "C 억제: OFF";
    if (!cEnabled) C = 0.0;
  };

  // ============================================================
  // MODE SWITCHING & LAYERS
  // ============================================================
  function switchMode(newMode) {
    if (newMode === currentMode) return;
    currentMode = newMode;

    el("modeStruct").style.opacity = currentMode === "struct" ? "1" : "0.6";
    el("modeStruct").textContent =
      currentMode === "struct" ? "구조 모드 (ON)" : "구조 모드";
    el("modeRD").style.opacity = currentMode === "rd" ? "1" : "0.6";
    el("modeRD").textContent = currentMode === "rd" ? "RD 모드 (ON)" : "RD 모드";

    initAll();
    C = 0.0;

    buildLayerUI();
    updateVisualizationDropdowns();
    updateCSourceDropdown();
    updateModeUI();
  }

  function updateModeUI() {
    const structControls = el("structControls");
    if (structControls) structControls.style.display = currentMode === "struct" ? "" : "none";

    const cStat = el("cStat");
    if (cStat) cStat.style.display = currentMode === "struct" ? "" : "none";

    if (currentMode !== "struct") {
      C = 0.0;
    }
  }

  function addStructLayer() {
    if (structLayers.length >= 5) {
      alert("최대 5개 계층까지만 추가 가능합니다.");
      return;
    }

    const lastLayer = structLayers[structLayers.length - 1];
    const layerName = String.fromCharCode(66 + structLayers.length - 1); // B, C, D...
    const tex = createTexMip();
    const layer = {
      id: structLayers.length,
      name: `${layerName} (from ${lastLayer.name})`,
      texture: tex,
      fbo: createFBO(tex, 0),
      fbo1x1: createFBO(tex, LAST_MIP_LEVEL),
      params: { gain: 5.0 },
      globalValue: 0.0,
    };
    structLayers.push(layer);

    buildLayerUI();
    updateVisualizationDropdowns();
    el("visRight").value = `struct-${layer.id}`;
    updateVisualizationConfig();
    updateCSourceDropdown({ selectLast: true });
    C = 0.0;
  }

  function addRDLayer() {
    if (rdStages.length >= 4) {
      alert("RD 모드는 최대 4단계까지 가능합니다: (a,b) → (X1,c) → (X2,d) → (X3,e)");
      return;
    }

    const prev = rdStages[rdStages.length - 1];
    prev.frozen = true;

    const stageId = rdStages.length;
    const yName = String.fromCharCode(99 + (stageId - 1)); // c,d,e
    const stage = createRDStage({
      id: stageId,
      name: `Stage ${stageId} (X${stageId}, ${yName})`,
      yName,
    });
    stage.params.diffX = params.diffA;
    stage.params.diffY = params.diffB;
    stage.params.feed = params.feed;
    stage.params.kill = params.kill;
    stage.params.drive = 2.0;
    rdStages.push(stage);
    initCascadeStageFromPrevX(stageId);

    buildLayerUI();
    updateVisualizationDropdowns();
    el("visRight").value = `rdy-${stageId}`;
    updateVisualizationConfig();
  }

  el("modeStruct").onclick = () => switchMode("struct");
  el("modeRD").onclick = () => switchMode("rd");
  el("addLayer").onclick = () => {
    if (currentMode === "struct") addStructLayer();
    else addRDLayer();
  };

  // ============================================================
  // LAYER UI
  // ============================================================
  function toggleLayer(id) {
    const toggle = el(`toggle-${id}`);
    const content = el(`content-${id}`);

    if (content.classList.contains("collapsed")) {
      content.classList.remove("collapsed");
      toggle.classList.remove("collapsed");
    } else {
      content.classList.add("collapsed");
      toggle.classList.add("collapsed");
    }
  }

  function addParamSlider(content, { id, labelText, min, max, step, value }, onInput) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "range";
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const output = document.createElement("output");
    output.id = id + "_o";
    output.value = (+value).toFixed(2);

    input.addEventListener("input", () => {
      const v = +input.value;
      output.value = v.toFixed(2);
      onInput(v);
    });
    input.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -parseFloat(input.step) : parseFloat(input.step);
        let newVal = parseFloat(input.value) + delta * 5;
        newVal = Math.max(parseFloat(input.min), Math.min(parseFloat(input.max), newVal));
        input.value = String(newVal);
        const v = +input.value;
        output.value = v.toFixed(2);
        onInput(v);
      },
      { passive: false }
    );

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(output);
    content.appendChild(row);
  }

  function buildLayerUI() {
    const container = el("layersContainer");
    container.innerHTML = "";

    if (currentMode === "struct") {
      for (const layer of structLayers) {
        const section = document.createElement("div");
        section.className = "layer-section";
        section.id = `layer-${layer.id}`;

        const header = document.createElement("div");
        header.className = "layer-header";
        header.onclick = () => toggleLayer(layer.id);
        header.innerHTML = `
          <span class="toggle" id="toggle-${layer.id}">▼</span>
          <span>${layer.name}</span>
          <span class="layer-value" id="layerVal-${layer.id}">—</span>
        `;

        const content = document.createElement("div");
        content.className = "layer-content";
        content.id = `content-${layer.id}`;

        addParamSlider(
          content,
          {
            id: `layer${layer.id}_gain`,
            labelText: "gain",
            min: 0.1,
            max: 20.0,
            step: 0.01,
            value: layer.params.gain,
          },
          (v) => {
            layer.params.gain = v;
            if (layer.id === 0) {
              const aGain = el("aGain");
              aGain.value = String(v);
              aGain.dispatchEvent(new Event("input"));
            }
          }
        );

        section.appendChild(header);
        section.appendChild(content);
        container.appendChild(section);
      }
    } else {
      for (const stage of rdStages) {
        const section = document.createElement("div");
        section.className = "layer-section";
        section.id = `layer-${stage.id}`;

        const header = document.createElement("div");
        header.className = "layer-header";
        header.onclick = () => toggleLayer(stage.id);
        header.innerHTML = `
          <span class="toggle" id="toggle-${stage.id}">▼</span>
          <span>${stage.name}</span>
          ${stage.frozen ? '<span class="frozen-badge">FROZEN</span>' : ""}
        `;

        const content = document.createElement("div");
        content.className = "layer-content";
        content.id = `content-${stage.id}`;

        if (stage.id > 0) {
          addParamSlider(
            content,
            {
              id: `layer${stage.id}_diffX`,
              labelText: "diffX",
              min: 0.0,
              max: 2.0,
              step: 0.001,
              value: stage.params.diffX,
            },
            (v) => (stage.params.diffX = v)
          );
          addParamSlider(
            content,
            {
              id: `layer${stage.id}_diffY`,
              labelText: `diff${stage.yName?.toUpperCase?.() || "Y"}`,
              min: 0.0,
              max: 2.0,
              step: 0.001,
              value: stage.params.diffY,
            },
            (v) => (stage.params.diffY = v)
          );
          addParamSlider(
            content,
            {
              id: `layer${stage.id}_feed`,
              labelText: "feed",
              min: 0.0,
              max: 0.1,
              step: 0.0001,
              value: stage.params.feed,
            },
            (v) => (stage.params.feed = v)
          );
          addParamSlider(
            content,
            {
              id: `layer${stage.id}_kill`,
              labelText: "kill",
              min: 0.0,
              max: 0.1,
              step: 0.0001,
              value: stage.params.kill,
            },
            (v) => (stage.params.kill = v)
          );
          addParamSlider(
            content,
            {
              id: `layer${stage.id}_drive`,
              labelText: "drive",
              min: 0.0,
              max: 10.0,
              step: 0.01,
              value: stage.params.drive,
            },
            (v) => (stage.params.drive = v)
          );

          const row = document.createElement("div");
          row.className = "row";
          const label = document.createElement("label");
          label.textContent = "freeze";
          const btn = document.createElement("button");
          btn.textContent = stage.frozen ? "UNFREEZE" : "FREEZE";
          btn.style.flex = "1";
          btn.onclick = () => {
            stage.frozen = !stage.frozen;
            buildLayerUI();
          };
          row.appendChild(label);
          row.appendChild(btn);
          content.appendChild(row);
        } else {
          const row = document.createElement("div");
          row.className = "row";
          const label = document.createElement("label");
          label.textContent = "stage0";
          const note = document.createElement("output");
          note.value =
            "전역 슬라이더(diffA/diffB/feed/kill/dt)로 제어, 계층 추가 시 기본은 FROZEN";
          row.appendChild(label);
          row.appendChild(note);
          content.appendChild(row);

          const row2 = document.createElement("div");
          row2.className = "row";
          const label2 = document.createElement("label");
          label2.textContent = "freeze";
          const btn = document.createElement("button");
          btn.textContent = stage.frozen ? "UNFREEZE" : "FREEZE";
          btn.style.flex = "1";
          btn.onclick = () => {
            stage.frozen = !stage.frozen;
            buildLayerUI();
          };
          row2.appendChild(label2);
          row2.appendChild(btn);
          content.appendChild(row2);
        }

        section.appendChild(header);
        section.appendChild(content);
        container.appendChild(section);
      }
    }
  }

  // ============================================================
  // VISUALIZATION
  // ============================================================
  let visConfig = {
    left: { texture: rdStages[0].ping.tex, channel: 0 },
    right: { texture: structLayers[0].texture, channel: 0 },
  };

  function updateVisualizationDropdowns() {
    const leftSel = el("visLeft");
    const rightSel = el("visRight");
    const leftVal = leftSel.value;
    const rightVal = rightSel.value;

    leftSel.innerHTML = "";
    rightSel.innerHTML = "";

    // Always provide base RD.
    leftSel.add(new Option("RD: a (X0)", "state-a"));
    leftSel.add(new Option("RD: b (Y0)", "state-b"));
    rightSel.add(new Option("RD: a (X0)", "state-a"));
    rightSel.add(new Option("RD: b (Y0)", "state-b"));

    if (currentMode === "struct") {
      for (const layer of structLayers) {
        leftSel.add(new Option(layer.name, `struct-${layer.id}`));
        rightSel.add(new Option(layer.name, `struct-${layer.id}`));
      }
    } else {
      for (const stage of rdStages) {
        leftSel.add(new Option(`RD: X${stage.id}`, `rdx-${stage.id}`));
        rightSel.add(new Option(`RD: X${stage.id}`, `rdx-${stage.id}`));
        if (stage.id === 0) continue;
        leftSel.add(new Option(`RD: ${stage.yName} (Y${stage.id})`, `rdy-${stage.id}`));
        rightSel.add(new Option(`RD: ${stage.yName} (Y${stage.id})`, `rdy-${stage.id}`));
      }
    }

    leftSel.value = leftVal || "state-a";
    rightSel.value = rightVal || (currentMode === "struct" ? "struct-0" : "state-b");
    updateVisualizationConfig();
  }

  function parseVisualizationSelection(sel) {
    const parts = sel.split("-");

    if (parts[0] === "state") {
      const v = parts[1];
      if (v === "a") return { texture: rdStages[0].ping.tex, channel: 0 };
      if (v === "b") return { texture: rdStages[0].ping.tex, channel: 1 };
      if (v === "c") return { texture: rdStages[1]?.ping.tex || rdStages[0].ping.tex, channel: 1 };
      if (v === "d") return { texture: rdStages[2]?.ping.tex || rdStages[0].ping.tex, channel: 1 };
      if (v === "e") return { texture: rdStages[3]?.ping.tex || rdStages[0].ping.tex, channel: 1 };
      return { texture: rdStages[0].ping.tex, channel: 0 };
    }

    if (parts[0] === "rdx") {
      const id = Math.max(0, Math.min(rdStages.length - 1, parseInt(parts[1], 10) || 0));
      return { texture: rdStages[id].ping.tex, channel: 0 };
    }
    if (parts[0] === "rdy") {
      const id = Math.max(1, Math.min(rdStages.length - 1, parseInt(parts[1], 10) || 1));
      return { texture: rdStages[id].ping.tex, channel: 1 };
    }

    if (parts[0] === "struct") {
      const id = Math.max(0, Math.min(structLayers.length - 1, parseInt(parts[1], 10) || 0));
      return { texture: structLayers[id].texture, channel: 0 };
    }

    return { texture: rdStages[0].ping.tex, channel: 0 };
  }

  function updateVisualizationConfig() {
    const leftVal = el("visLeft").value;
    const rightVal = el("visRight").value;
    visConfig.left = parseVisualizationSelection(leftVal);
    visConfig.right = parseVisualizationSelection(rightVal);
  }

  el("visLeft").addEventListener("change", updateVisualizationConfig);
  el("visRight").addEventListener("change", updateVisualizationConfig);

  // ============================================================
  // C SOURCE (STRUCT LAYER SELECTION)
  // ============================================================
  function updateCSourceDropdown({ selectLast = false } = {}) {
    const sel = el("cSource");
    if (!sel) return;

    const prev = sel.value;
    sel.innerHTML = "";
    for (const layer of structLayers) sel.add(new Option(layer.name, String(layer.id)));

    sel.disabled = currentMode !== "struct";
    if (!sel.options.length) return;

    if (selectLast) {
      sel.value = String(structLayers.length - 1);
      return;
    }

    const hasPrev = Array.from(sel.options).some((o) => o.value === prev);
    sel.value = hasPrev ? prev : "0";
  }

  el("cSource").addEventListener("change", () => {
    C = 0.0;
  });

  updateCSourceDropdown();
  buildLayerUI();
  updateVisualizationDropdowns();
  updateModeUI();

  // ============================================================
  // MAIN LOOP
  // ============================================================
  let lastT = performance.now();
  let fpsAcc = 0;
  let fpsN = 0;
  let fpsLast = performance.now();

  function step() {
    resize();

    if (!paused) {
      // 1) RD cascade update
      if (!rdStages[0].frozen) {
        const inhEff = currentMode === "struct" ? params.inh : 0.0;
        const CEff = currentMode === "struct" ? C : 0.0;
        drawTo(rdStages[0].pong.fbo, SIM, SIM, progRD0, () => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, rdStages[0].ping.tex);
          gl.uniform1i(rd0U.uState, 0);
          gl.uniform2f(rd0U.uTexel, 1.0 / SIM, 1.0 / SIM);
          gl.uniform1f(rd0U.diffA, params.diffA);
          gl.uniform1f(rd0U.diffB, params.diffB);
          gl.uniform1f(rd0U.feed, params.feed);
          gl.uniform1f(rd0U.kill, params.kill);
          gl.uniform1f(rd0U.dt, params.dt);
          gl.uniform1f(rd0U.inh, inhEff);
          gl.uniform1f(rd0U.C, CEff);
        });
        rdStages[0].swap();
      }

      for (let i = 1; i < rdStages.length; i++) {
        const stage = rdStages[i];
        const prev = rdStages[i - 1];
        if (stage.frozen) continue;
        drawTo(stage.pong.fbo, SIM, SIM, progRDCascade, () => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, stage.ping.tex);
          gl.uniform1i(rdCU.uState, 0);

          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, prev.ping.tex);
          gl.uniform1i(rdCU.uPrev, 1);

          gl.uniform2f(rdCU.uTexel, 1.0 / SIM, 1.0 / SIM);
          gl.uniform1f(rdCU.diffX, stage.params.diffX);
          gl.uniform1f(rdCU.diffY, stage.params.diffY);
          gl.uniform1f(rdCU.feed, stage.params.feed);
          gl.uniform1f(rdCU.kill, stage.params.kill);
          gl.uniform1f(rdCU.dt, params.dt);
          gl.uniform1f(rdCU.drive, stage.params.drive);
        });
        stage.swap();
      }

      // 2) Structure layers from base X (a)
      if (currentMode === "struct") {
        for (let i = 0; i < structLayers.length; i++) {
          const layer = structLayers[i];
          const sourceTex = i === 0 ? rdStages[0].ping.tex : structLayers[i - 1].texture;
          drawTo(layer.fbo, SIM, SIM, progStruct, () => {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, sourceTex);
            gl.uniform1i(stU.uState, 0);
            gl.uniform2f(stU.uTexel, 1.0 / SIM, 1.0 / SIM);
            gl.uniform1f(stU.gain, layer.params.gain);
          });

          gl.bindTexture(gl.TEXTURE_2D, layer.texture);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.bindTexture(gl.TEXTURE_2D, null);

          gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fbo1x1);
          const pix = new Float32Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pix);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          layer.globalValue = Math.min(1.0, Math.max(0.0, pix[0] || 0.0));

          const valEl = document.getElementById(`layerVal-${layer.id}`);
          if (valEl) valEl.textContent = layer.globalValue.toFixed(3);
        }

        if (structLayers.length > 0) {
          const sel = el("cSource");
          const selId = sel ? parseInt(sel.value, 10) : 0;
          const src =
            structLayers[Math.min(structLayers.length - 1, Math.max(0, selId))] ||
            structLayers[0];
          const rawC = src.globalValue;
          C = cEnabled ? params.cSmooth * C + (1.0 - params.cSmooth) * rawC : 0.0;
          const cval = el("cval");
          if (cval) cval.textContent = C.toFixed(4);
        }
      } else {
        C = 0.0;
      }
    }

    // 4) Render split-screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(progRender);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, visConfig.left.texture);
    gl.uniform1i(reU.uLeftTex, 0);
    gl.uniform1i(reU.uLeftChannel, visConfig.left.channel);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, visConfig.right.texture);
    gl.uniform1i(reU.uRightTex, 1);
    gl.uniform1i(reU.uRightChannel, visConfig.right.channel);

    gl.uniform1f(reU.C, C);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // FPS
    const now = performance.now();
    const dtMs = now - lastT;
    lastT = now;
    fpsAcc += 1000.0 / Math.max(1e-6, dtMs);
    fpsN++;
    if (now - fpsLast > 500) {
      el("fps").textContent = (fpsAcc / fpsN).toFixed(0);
      fpsAcc = 0;
      fpsN = 0;
      fpsLast = now;
    }

    requestAnimationFrame(step);
  }

  console.log(`[${BUILD}] demo booted`);
  requestAnimationFrame(step);
})();
