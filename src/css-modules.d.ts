/**
 * CSS Modules type shim for the tsdown client bundle: class maps are plain
 * string records (the bundler injects the compiled stylesheet + hashed map).
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}