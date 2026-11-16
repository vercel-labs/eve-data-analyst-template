/** Files imported with `?raw` arrive as their UTF-8 text, in both eve's bundler and vitest. */
declare module "*?raw" {
  const text: string;
  export default text;
}
