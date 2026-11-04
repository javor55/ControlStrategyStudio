// Vite `?inline` imports return a data: URL string.
declare module '*.ttf?inline' {
  const dataUrl: string;
  export default dataUrl;
}
