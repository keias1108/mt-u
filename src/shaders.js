/* @fileoverview GLSL shader sources for the WebGL2 hierarchical RD demo. */

(() => {
  window.DemoShaders = {
    quadVS: `#version 300 es
precision highp float;
out vec2 vUV;
void main(){
  vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2);
  vUV = p;
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`,

    rdBaseFS: `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float diffA, diffB, feed, kill, dt;
uniform float inh;
uniform float C;
in vec2 vUV;
layout(location=0) out vec4 outColor;

vec2 s2(vec2 uv){ return texture(uState, uv).rg; }

void main(){
  vec2 ab = s2(vUV);
  float a = ab.r;
  float b = ab.g;

  vec2 n  = s2(vUV + vec2(0.0,  uTexel.y));
  vec2 s  = s2(vUV + vec2(0.0, -uTexel.y));
  vec2 e  = s2(vUV + vec2( uTexel.x, 0.0));
  vec2 w  = s2(vUV + vec2(-uTexel.x, 0.0));
  vec2 lap = (n + s + e + w - 4.0*ab);

  float reaction = a*b*b;
  float da = diffA*lap.r - reaction + feed*(1.0 - a) - inh*C*a;
  float db = diffB*lap.g + reaction - (kill + feed)*b;

  a = clamp(a + da*dt, 0.0, 1.0);
  b = clamp(b + db*dt, 0.0, 1.0);

  outColor = vec4(a, b, 0.0, 0.0);
}`,

    rdCascadeFS: `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float diffX, diffY, feed, kill, dt;
uniform float drive;
in vec2 vUV;
layout(location=0) out vec4 outColor;

vec2 s2(vec2 uv){ return texture(uState, uv).rg; }

void main(){
  vec2 xy = s2(vUV);
  float x = xy.r;
  float y = xy.g;

  vec2 n  = s2(vUV + vec2(0.0,  uTexel.y));
  vec2 s  = s2(vUV + vec2(0.0, -uTexel.y));
  vec2 e  = s2(vUV + vec2( uTexel.x, 0.0));
  vec2 w  = s2(vUV + vec2(-uTexel.x, 0.0));
  vec2 lap = (n + s + e + w - 4.0*xy);

  vec2 p = texture(uPrev, vUV).rg;
  float xIn = clamp(p.r * p.g * p.g, 0.0, 1.0);
  float reaction = x*y*y;
  float dx = diffX*lap.r - reaction + feed*(1.0 - x) + drive*(xIn - x);
  float dy = diffY*lap.g + reaction - (kill + feed)*y;

  x = clamp(x + dx*dt, 0.0, 1.0);
  y = clamp(y + dy*dt, 0.0, 1.0);

  outColor = vec4(x, y, 0.0, 0.0);
}`,

    initFromPrevFS: `#version 300 es
precision highp float;
uniform sampler2D uPrev;
in vec2 vUV;
layout(location=0) out vec4 outColor;

float blob(vec2 c, float r){
  return step(length(vUV - c), r);
}

void main(){
  vec2 p = texture(uPrev, vUV).rg;
  float x = clamp(p.r * p.g * p.g, 0.0, 1.0);
  float y = 0.0;
  y = max(y, blob(vec2(0.50, 0.50), 0.050) * 0.85);
  y = max(y, blob(vec2(0.65, 0.40), 0.040) * 0.75);
  y = max(y, blob(vec2(0.30, 0.64), 0.036) * 0.70);
  outColor = vec4(x, y, 0.0, 0.0);
}`,

    structureFS: `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float gain;
in vec2 vUV;
layout(location=0) out vec4 outColor;

float aAt(vec2 uv){ return texture(uState, uv).r; }

void main(){
  float aN = aAt(vUV + vec2(0.0,  uTexel.y));
  float aS = aAt(vUV + vec2(0.0, -uTexel.y));
  float aE = aAt(vUV + vec2( uTexel.x, 0.0));
  float aW = aAt(vUV + vec2(-uTexel.x, 0.0));

  float dx = (aE - aW) * 0.5;
  float dy = (aN - aS) * 0.5;
  float g = sqrt(dx*dx + dy*dy) * gain;

  outColor = vec4(clamp(g, 0.0, 1.0), 0.0, 0.0, 0.0);
}`,

    renderFS: `#version 300 es
precision highp float;
uniform sampler2D uLeftTex;
uniform sampler2D uRightTex;
uniform int uLeftChannel;
uniform int uRightChannel;
uniform float C;
in vec2 vUV;
out vec4 outColor;

float ramp(float x){
  x = clamp(x, 0.0, 1.0);
  return smoothstep(0.1, 0.9, x);
}

float getChannel(sampler2D tex, vec2 uv, int ch){
  vec4 val = texture(tex, uv);
  if (ch == 0) return val.r;
  if (ch == 1) return val.g;
  if (ch == 2) return val.b;
  return val.a;
}

void main(){
  bool right = (vUV.x > 0.5);
  vec2 uv = vUV;
  uv.x = right ? (uv.x - 0.5)*2.0 : uv.x*2.0;

  if (!right){
    float val = getChannel(uLeftTex, uv, uLeftChannel);
    float v = ramp(val);
    outColor = vec4(vec3(v), 1.0);
  } else {
    float val = getChannel(uRightTex, uv, uRightChannel);
    float v = ramp(val);
    float bar = step(0.98, uv.y) * step(uv.x, clamp(C,0.0,1.0));
    vec3 col = vec3(v);
    col = mix(col, vec3(1.0), bar);
    outColor = vec4(col, 1.0);
  }
}`,
  };
})();
