import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import ui from '@nuxt/ui/vue-plugin'
import { addCollection } from '@iconify/vue'
import lucide from '@iconify-json/lucide/icons.json'
import App from './App.vue'
import { installBridge } from './bridge'
import './assets/css/main.css'

// Bundle the icon set instead of letting it be fetched.
//
// Nuxt UI's icons are Iconify names (`i-lucide-clock`), and outside a Nuxt build
// `@iconify/vue` resolves an unknown name by calling api.iconify.design at
// runtime. That is wrong here twice over: the app's CSP has no `connect-src` for
// it (correctly — the webview makes no HTTP requests of its own), so every icon
// silently rendered blank in the packaged build, and even with the CSP opened it
// would make a local desktop app's chrome depend on an internet round trip.
//
// The whole collection is registered rather than the ~45 names this app writes
// itself: Nuxt UI's own components pull icons from their theme defaults
// (a select's chevron, a modal's close button), so a hand-maintained subset
// would go stale as a silently missing glyph. The cost is a few hundred KB in a
// bundle that is read from local disk.
addCollection(lucide)

// Before anything renders: the onboarding gate in `App.vue` calls
// `window.openproject.hasCredentials()` on mount, so the bridge has to exist by
// then. In the Electron app the preload script guaranteed that; here it is one
// explicit call.
installBridge()

const app = createApp(App)
// Order matters: Pinia first (Colada's query cache lives inside the Pinia
// store), then Colada, then Nuxt UI. See `docs/conventions-frontend.md`
// ("Server State: Pinia Colada").
const pinia = createPinia()
app.use(pinia)
app.use(PiniaColada)
app.use(ui)
app.mount('#app')
