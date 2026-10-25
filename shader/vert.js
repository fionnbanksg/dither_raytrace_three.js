// Vertex shader: just a fullscreen quad. All the work happens in the fragment shader.

export default /* glsl */`
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
