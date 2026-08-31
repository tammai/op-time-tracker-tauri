/**
 * Types for the build-time virtual modules in `vite.config.ts`.
 *
 * `virtual:lucide-subset` is an Iconify collection sliced down to the icons this
 * app renders. The shape is `IconifyJSON`, but it is declared structurally here
 * rather than imported from `@iconify/types` so the frontend's type-check does
 * not depend on a transitive package.
 */
declare module 'virtual:lucide-subset' {
  const collection: {
    prefix: string
    icons: Record<string, { body: string; width?: number; height?: number }>
    aliases?: Record<string, { parent: string }>
    width?: number
    height?: number
  }
  export default collection
}
